import { type Context, Hono } from "hono";
import type { AuthVariables } from "./authMiddleware";
import { canManageOrganization } from "./organizationMembers";
import {
  StripeApiError,
  StripeConfigurationError,
  stripeDelete,
  stripeGet,
  stripePost,
  verifyStripeWebhook,
} from "./stripe";
import type { Bindings } from "./types";
import { readWebhookPayload } from "./webhookPayload";

export const freeFormTemplateLimit = 5;
export const freeRetentionDays = 30;
const unlimitedSeatLimit = Number.MAX_SAFE_INTEGER;
const paidStatuses = new Set(["active", "past_due", "trialing"]);
const maxStripeWebhookBytes = 256 * 1024;
const terminalSubscriptionStatuses = new Set([
  "canceled",
  "incomplete_expired",
]);
const webhookClaimTimeoutMilliseconds = 5 * 60 * 1000;
const checkoutDurationSeconds = 35 * 60;
const pendingCheckoutReconciliationLimit = 25;
const pendingCheckoutRetrySeconds = 5 * 60;
const subscriptionSeatReconciliationLimit = 25;
const subscriptionSyncClaimSeconds = 2 * 60;
const stripeWebhookReceiptCleanupLimit = 500;
const stripeWebhookReceiptRetentionDays = 31;
const checkoutDeletionLeaseSeconds = 5 * 60;

type BillingEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};

interface BillingRow {
  cancel_at_period_end: number;
  checkout_claim_customer_id: string | null;
  checkout_claim_expires_at: number | null;
  checkout_claim_id: string | null;
  checkout_claim_price_id: string | null;
  checkout_claim_quantity: number | null;
  checkout_disabled_at: string | null;
  checkout_disabled_expires_at: number | null;
  current_period_end: string | null;
  last_reconciled_at: string | null;
  pending_checkout_expires_at: number | null;
  pending_checkout_retry_at: number | null;
  pending_checkout_session_id: string | null;
  pending_checkout_url: string | null;
  seat_quantity: number;
  stripe_customer_id: string | null;
  stripe_event_created: number;
  stripe_price_id: string | null;
  stripe_status: string | null;
  stripe_subscription_id: string | null;
  stripe_subscription_item_id: string | null;
  updated_at: string;
}

interface StripeCheckoutSession {
  client_reference_id: string | null;
  customer: StripeExpandable | null;
  expires_at?: number;
  id: string;
  metadata?: {
    checkout_claim_id?: string;
    organization_id?: string;
    [key: string]: string | undefined;
  };
  status: string | null;
  subscription: StripeExpandable | StripeSubscription | null;
  url?: string | null;
}

interface StripeSubscriptionItem {
  current_period_end?: number;
  id: string;
  price: { id: string };
  quantity?: number;
}

interface StripeSeatItemResponse {
  id: string;
  quantity: number;
}

interface StripeSubscription {
  cancel_at?: number | null;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  customer: StripeExpandable;
  id: string;
  items: { data: StripeSubscriptionItem[] };
  metadata?: {
    checkout_claim_id?: string;
    organization_id?: string;
    [key: string]: string | undefined;
  };
  status: string;
}

interface StripeEvent {
  created: number;
  data: { object: unknown };
  id: string;
  type: string;
}

interface StripePayloadRecord extends Record<string, unknown> {
  cancel_at?: unknown;
  cancel_at_period_end?: unknown;
  client_reference_id?: unknown;
  current_period_end?: unknown;
  customer?: unknown;
  data?: unknown;
  expires_at?: unknown;
  id?: unknown;
  items?: unknown;
  metadata?: unknown;
  parent?: unknown;
  price?: unknown;
  quantity?: unknown;
  status?: unknown;
  subscription?: unknown;
  subscription_details?: unknown;
  url?: unknown;
}

type StripeExpandable = string | { id: string };

const billing = new Hono<BillingEnv>();

billing.get("/", async (context) => {
  const organizationId = context.get("organizationId");
  const sessionId = context.req.query("session_id");
  if (sessionId) {
    if (!canManageOrganization(context.get("organizationRole"))) {
      return context.json(
        { error: "Organization billing access is required." },
        403,
      );
    }
    if (!sessionId.startsWith("cs_") || sessionId.length > 255) {
      return context.json({ error: "Checkout session is invalid." }, 400);
    }
    try {
      await confirmCheckoutSession(context.env, organizationId, sessionId);
    } catch (cause) {
      return billingError(context, cause);
    }
  }
  return context.json(
    await billingSummary(
      context.env.DB,
      organizationId,
      context.get("organizationRole"),
      context.env.STRIPE_PRO_PRICE_ID,
      context.env.STRIPE_PRO_LEGACY_PRICE_IDS,
    ),
  );
});

billing.post("/checkout", async (context) => {
  if (!canManageOrganization(context.get("organizationRole"))) {
    return context.json(
      { error: "Organization billing access is required." },
      403,
    );
  }
  const organizationId = context.get("organizationId");
  const priceId = context.env.STRIPE_PRO_PRICE_ID;
  if (!priceId) return billingUnavailableResponse(context);
  const prepared = await prepareCheckoutState(context, organizationId);
  if (prepared instanceof Response) return prepared;
  const state = prepared;
  const checkoutClaim = await claimCheckout(
    context.env.DB,
    organizationId,
    priceId,
    Math.max(1, state.memberCount),
    state.nowSeconds,
  );
  const record = checkoutClaim.record;
  if (isPaidBillingForEnvironment(record, context.env))
    return alreadyProResponse(context);
  if (checkoutDeletionInProgress(record, state.nowSeconds))
    return checkoutDisabledResponse(context);
  const claimedPending = activePendingCheckout(record, state.nowSeconds);
  if (claimedPending) return context.json({ url: claimedPending.url });
  if (!checkoutClaim.owned || !completeCheckoutClaim(record, checkoutClaim.id))
    return checkoutInProgressResponse(context);
  const parameters = checkoutParameters(
    context.env.CORS_ORIGIN,
    organizationId,
    record.checkout_claim_price_id,
    record,
  );
  try {
    const checkout = parseStripeCheckoutSession(
      await stripePost(
        context.env,
        "/v1/checkout/sessions",
        parameters,
        `checkout:${organizationId}:${checkoutClaim.id}`,
      ),
    );
    if (!validCreatedCheckout(checkout)) {
      throw new StripeApiError("Stripe did not return a checkout URL.", 502);
    }
    const stored = await storePendingCheckout(
      context.env.DB,
      organizationId,
      checkoutClaim.id,
      checkout,
    );
    if (!stored) {
      await expireCheckoutSession(context.env, checkout.id);
      return context.json(
        { error: "Checkout could not be reserved. Please try again." },
        409,
      );
    }
    return context.json({ url: checkout.url });
  } catch (cause) {
    return checkoutCreationError(
      context,
      cause,
      organizationId,
      checkoutClaim.id,
    );
  }
});

billing.post("/portal", async (context) => {
  if (!canManageOrganization(context.get("organizationRole"))) {
    return context.json(
      { error: "Organization billing access is required." },
      403,
    );
  }
  const organizationId = context.get("organizationId");
  const record = await findBilling(context.env.DB, organizationId);
  if (!record?.stripe_customer_id) {
    return context.json(
      { error: "This organization does not have a billing account yet." },
      409,
    );
  }
  const parameters = new URLSearchParams({
    customer: record.stripe_customer_id,
    return_url: `${context.env.CORS_ORIGIN}/organization/billing`,
  });
  if (context.env.STRIPE_PORTAL_CONFIGURATION_ID) {
    parameters.set("configuration", context.env.STRIPE_PORTAL_CONFIGURATION_ID);
  }
  try {
    const portal = parseStripePortalSession(
      await stripePost(context.env, "/v1/billing_portal/sessions", parameters),
    );
    if (!portal.url) throw new Error("Stripe did not return a portal URL.");
    return context.json({ url: portal.url });
  } catch (cause) {
    return billingError(context, cause);
  }
});

export async function handleStripeWebhook(context: Context<BillingEnv>) {
  const payload = await readWebhookPayload(
    context.req.raw,
    maxStripeWebhookBytes,
  );
  if (payload === null) {
    return context.json({ error: "Webhook payload is too large." }, 413);
  }
  let verified: boolean;
  try {
    verified = await verifyStripeWebhook(
      payload,
      context.req.header("stripe-signature"),
      context.env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (cause) {
    if (cause instanceof StripeConfigurationError) {
      console.error(cause.message);
      return context.json(
        { error: "Webhook verification is unavailable." },
        503,
      );
    }
    throw cause;
  }
  if (!verified) {
    return context.json({ error: "Webhook signature is invalid." }, 400);
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(new TextDecoder().decode(payload)) as StripeEvent;
  } catch {
    return context.json({ error: "Webhook payload is invalid." }, 400);
  }
  if (!validEvent(event)) {
    return context.json({ error: "Webhook event is invalid." }, 400);
  }
  const claimed = await claimWebhookEvent(context.env.DB, event);
  if (claimed === "processed") return context.json({ received: true });
  if (claimed === "processing") {
    return context.json(
      { error: "Webhook event is already being processed." },
      503,
    );
  }
  try {
    await processStripeEvent(context.env, event);
    await context.env.DB.prepare(
      `UPDATE stripe_webhook_events SET processed_at = ? WHERE id = ?`,
    )
      .bind(new Date().toISOString(), event.id)
      .run();
  } catch (cause) {
    await context.env.DB.prepare(
      `DELETE FROM stripe_webhook_events WHERE id = ? AND processed_at IS NULL`,
    )
      .bind(event.id)
      .run();
    throw cause;
  }
  return context.json({ received: true });
}

export async function organizationSeatLimit(
  database: D1Database,
  organizationId: string,
  priceId: string | undefined,
  legacyPriceIds?: string,
) {
  return (await organizationHasPro(
    database,
    organizationId,
    priceId,
    legacyPriceIds,
  ))
    ? unlimitedSeatLimit
    : 1;
}

export async function organizationInvitationLimit(
  database: D1Database,
  organizationId: string,
  priceId: string | undefined,
  legacyPriceIds?: string,
) {
  return (await organizationHasPro(
    database,
    organizationId,
    priceId,
    legacyPriceIds,
  ))
    ? unlimitedSeatLimit
    : 0;
}

export async function organizationTemplateLimit(
  database: D1Database,
  organizationId: string,
  priceId: string | undefined,
  legacyPriceIds?: string,
) {
  return (await organizationHasPro(
    database,
    organizationId,
    priceId,
    legacyPriceIds,
  ))
    ? null
    : freeFormTemplateLimit;
}

export async function organizationUserHasSeat(
  database: D1Database,
  organizationId: string,
  userId: string,
  priceId: string | undefined,
  legacyPriceIds?: string,
) {
  if (
    await organizationHasPro(database, organizationId, priceId, legacyPriceIds)
  )
    return true;
  const row = await database
    .prepare(
      `SELECT userId
       FROM member
       WHERE organizationId = ?
       ORDER BY
         CASE
           WHEN (',' || replace(role, ' ', '') || ',') LIKE '%,owner,%'
             THEN 0
           ELSE 1
         END,
         createdAt ASC,
         id ASC
       LIMIT 1`,
    )
    .bind(organizationId)
    .first<{ userId: string }>();
  return row?.userId === userId;
}

export async function syncOrganizationSeats(
  environment: Pick<
    Bindings,
    | "DB"
    | "STRIPE_PRO_LEGACY_PRICE_IDS"
    | "STRIPE_PRO_PRICE_ID"
    | "STRIPE_SECRET_KEY"
  >,
  organizationId: string,
  verifyStripeQuantity = false,
) {
  const initialRecord = await findBilling(environment.DB, organizationId);
  if (
    !isPaidBilling(
      initialRecord,
      environment.STRIPE_PRO_PRICE_ID,
      environment.STRIPE_PRO_LEGACY_PRICE_IDS,
    ) ||
    !initialRecord?.stripe_subscription_item_id
  ) {
    return false;
  }
  const lockId = subscriptionLockId(initialRecord);
  return withSubscriptionSyncLock(
    environment.DB,
    lockId,
    async () =>
      syncOrganizationSeatsLocked(
        environment,
        organizationId,
        lockId,
        verifyStripeQuantity,
      ),
    true,
  );
}

async function syncOrganizationSeatsLocked(
  environment: Pick<
    Bindings,
    | "DB"
    | "STRIPE_PRO_LEGACY_PRICE_IDS"
    | "STRIPE_PRO_PRICE_ID"
    | "STRIPE_SECRET_KEY"
  >,
  organizationId: string,
  lockId: string,
  verifyStripeQuantity: boolean,
) {
  const record = await findBilling(environment.DB, organizationId);
  if (
    !isPaidBilling(
      record,
      environment.STRIPE_PRO_PRICE_ID,
      environment.STRIPE_PRO_LEGACY_PRICE_IDS,
    ) ||
    !record?.stripe_subscription_item_id ||
    subscriptionLockId(record) !== lockId
  ) {
    return false;
  }
  const quantity = Math.max(
    1,
    await countMembers(environment.DB, organizationId),
  );
  if (quantity === record.seat_quantity && !verifyStripeQuantity) return false;
  if (verifyStripeQuantity) {
    const stripeItem = parseStripeSeatItemResponse(
      await stripeGet(
        environment,
        `/v1/subscription_items/${encodeURIComponent(record.stripe_subscription_item_id)}`,
      ),
    );
    if (
      stripeItem.id === record.stripe_subscription_item_id &&
      stripeItem.quantity === quantity
    ) {
      if (record.seat_quantity !== quantity) {
        await updateStoredSeatQuantity(
          environment.DB,
          organizationId,
          record.stripe_subscription_item_id,
          quantity,
        );
      }
      return false;
    }
  }
  const stripeItem = parseStripeSeatItemResponse(
    await stripePost(
      environment,
      `/v1/subscription_items/${encodeURIComponent(record.stripe_subscription_item_id)}`,
      new URLSearchParams({
        proration_behavior: "create_prorations",
        quantity: String(quantity),
      }),
      [
        "seats",
        organizationId,
        record.stripe_subscription_item_id,
        record.seat_quantity,
        quantity,
        record.updated_at,
      ].join(":"),
    ),
  );
  if (
    stripeItem.id !== record.stripe_subscription_item_id ||
    stripeItem.quantity !== quantity
  ) {
    throw new StripeApiError("Stripe did not update the seat quantity.", 502);
  }
  await updateStoredSeatQuantity(
    environment.DB,
    organizationId,
    record.stripe_subscription_item_id,
    quantity,
  );
  return true;
}

function subscriptionLockId(record: BillingRow) {
  return (
    record.stripe_subscription_id ??
    `subscription-item:${record.stripe_subscription_item_id ?? "missing"}`
  );
}

export async function reconcileSubscriptionSeats(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_PRICE_ID" | "STRIPE_SECRET_KEY"
  >,
) {
  const rows = await environment.DB.prepare(
    `SELECT organization_id
     FROM organization_billing
     WHERE stripe_subscription_item_id IS NOT NULL
       AND stripe_status IN ('active', 'past_due', 'trialing')
     ORDER BY last_reconciled_at IS NOT NULL ASC,
              last_reconciled_at ASC,
              organization_id ASC
     LIMIT ?`,
  )
    .bind(subscriptionSeatReconciliationLimit)
    .all<{ organization_id: string }>();
  let firstFailure: unknown;
  for (const row of rows.results) {
    try {
      await syncOrganizationSeats(environment, row.organization_id, true);
    } catch (cause) {
      firstFailure ??= cause;
    } finally {
      try {
        await environment.DB.prepare(
          `UPDATE organization_billing SET last_reconciled_at = ?
           WHERE organization_id = ?`,
        )
          .bind(new Date().toISOString(), row.organization_id)
          .run();
      } catch (cause) {
        firstFailure ??= cause;
      }
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
}

export async function reconcilePendingCheckoutEntitlements(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_PRICE_ID" | "STRIPE_SECRET_KEY"
  >,
  nowSeconds = Math.floor(Date.now() / 1_000),
) {
  const pending = await environment.DB.prepare(
    `SELECT organization_id, pending_checkout_session_id
     FROM organization_billing
     WHERE pending_checkout_session_id IS NOT NULL
       AND COALESCE(pending_checkout_expires_at, 0) <= ?
       AND COALESCE(pending_checkout_retry_at, 0) <= ?
     ORDER BY pending_checkout_retry_at IS NOT NULL ASC,
              pending_checkout_retry_at ASC,
              pending_checkout_expires_at ASC,
              organization_id ASC
     LIMIT ?`,
  )
    .bind(nowSeconds, nowSeconds, pendingCheckoutReconciliationLimit)
    .all<{
      organization_id: string;
      pending_checkout_session_id: string;
    }>();
  for (const row of pending.results) {
    try {
      await reconcilePendingCheckoutEntitlement(
        environment,
        row.organization_id,
        row.pending_checkout_session_id,
        nowSeconds,
      );
    } catch (cause) {
      await deferPendingCheckoutReconciliation(
        environment.DB,
        row.organization_id,
        row.pending_checkout_session_id,
        nowSeconds,
      ).catch((retryCause: unknown) => {
        console.error(
          "Pending Checkout retry could not be scheduled",
          row.organization_id,
          retryCause,
        );
      });
      console.error(
        "Pending Checkout reconciliation failed",
        row.organization_id,
        cause,
      );
    }
  }
}

async function deferPendingCheckoutReconciliation(
  database: D1Database,
  organizationId: string,
  sessionId: string,
  nowSeconds: number,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET pending_checkout_retry_at = ?, updated_at = ?
       WHERE organization_id = ? AND pending_checkout_session_id = ?`,
    )
    .bind(
      nowSeconds + pendingCheckoutRetrySeconds,
      new Date(nowSeconds * 1_000).toISOString(),
      organizationId,
      sessionId,
    )
    .run();
}

export async function purgeStripeWebhookReceipts(
  environment: Pick<Bindings, "DB">,
  retainedAfter = new Date(
    Date.now() - stripeWebhookReceiptRetentionDays * 24 * 60 * 60 * 1_000,
  ).toISOString(),
) {
  const deleted = await environment.DB.prepare(
    `DELETE FROM stripe_webhook_events
     WHERE id IN (
       SELECT id FROM stripe_webhook_events
       WHERE datetime(COALESCE(processed_at, received_at)) < datetime(?)
       ORDER BY datetime(COALESCE(processed_at, received_at)) ASC, id ASC
       LIMIT ?
     )
     RETURNING id`,
  )
    .bind(retainedAfter, stripeWebhookReceiptCleanupLimit)
    .all<{ id: string }>();
  return deleted.results.length;
}

async function reconcilePendingCheckoutEntitlement(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_PRICE_ID" | "STRIPE_SECRET_KEY"
  >,
  organizationId: string,
  sessionId: string,
  nowSeconds: number,
) {
  let session = parseStripeCheckoutSession(
    await stripeGet(
      environment,
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    ),
  );
  const sessionOrganizationId =
    session.client_reference_id ?? session.metadata?.organization_id;
  if (sessionOrganizationId !== organizationId) {
    throw new StripeApiError(
      "Pending Checkout does not belong to its organization.",
      409,
    );
  }
  if (
    session.status === "open" &&
    (!session.expires_at || session.expires_at <= nowSeconds)
  ) {
    session = await expireOrReloadCheckoutSession(environment, sessionId);
  }
  if (session.status === "expired") {
    await clearPendingCheckoutIfCurrent(
      environment.DB,
      organizationId,
      sessionId,
    );
    return;
  }
  if (session.status === "complete") {
    const subscriptionId = optionalExpandableId(session.subscription);
    if (
      !subscriptionId ||
      !(await refreshSubscription(
        environment,
        subscriptionId,
        nowSeconds,
        organizationId,
        sessionId,
        session.metadata?.checkout_claim_id,
      ))
    ) {
      throw new StripeApiError(
        "Pending Checkout entitlement could not be reconciled.",
        409,
      );
    }
    return;
  }
  if (
    session.status === "open" &&
    session.expires_at &&
    session.expires_at > nowSeconds
  ) {
    await environment.DB.prepare(
      `UPDATE organization_billing
       SET pending_checkout_expires_at = ?, pending_checkout_retry_at = NULL,
           updated_at = ?
       WHERE organization_id = ? AND pending_checkout_session_id = ?`,
    )
      .bind(
        session.expires_at,
        new Date().toISOString(),
        organizationId,
        sessionId,
      )
      .run();
    return;
  }
  throw new StripeApiError(
    "Pending Checkout entitlement could not be reconciled.",
    409,
  );
}

export async function cancelOrganizationSubscription(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_PRICE_ID" | "STRIPE_SECRET_KEY"
  >,
  organizationId: string,
) {
  const deletion = await disableCheckoutForDeletion(
    environment.DB,
    organizationId,
  );
  if (!deletion) {
    if (!(await organizationExists(environment.DB, organizationId))) {
      return { canceled: false, checkoutGuard: null };
    }
    throw new StripeApiError(
      "Organization deletion is already in progress.",
      409,
    );
  }
  const { checkoutGuard, record } = deletion;
  try {
    const pendingSubscriptionId = await resolvePendingCheckoutForDeletion(
      environment,
      record,
    );
    const subscriptionIds = new Set<string>();
    if (
      record?.stripe_subscription_id &&
      !terminalSubscriptionStatuses.has(record.stripe_status ?? "")
    ) {
      subscriptionIds.add(record.stripe_subscription_id);
    }
    if (pendingSubscriptionId) subscriptionIds.add(pendingSubscriptionId);
    for (const subscriptionId of subscriptionIds) {
      await cancelStripeSubscription(
        environment,
        organizationId,
        subscriptionId,
      );
    }
    await clearPendingCheckout(environment.DB, organizationId);
    return {
      canceled:
        subscriptionIds.size > 0 ||
        Boolean(record?.pending_checkout_session_id),
      checkoutGuard,
    };
  } catch (cause) {
    await enableCheckoutAfterFailedDeletion(
      environment.DB,
      organizationId,
      checkoutGuard,
    );
    throw cause;
  }
}

export async function recoverCheckoutAfterFailedDeletion(
  database: D1Database,
  organizationId: string,
  checkoutGuard: string | null,
) {
  if (!checkoutGuard) return false;
  const recovered = await database
    .prepare(
      `UPDATE organization_billing
       SET checkout_disabled_at = NULL,
           checkout_disabled_expires_at = NULL,
           updated_at = ?
       WHERE organization_id = ? AND checkout_disabled_at = ?
         AND EXISTS (
           SELECT 1 FROM organization
           WHERE id = ? AND deletedAt IS NULL
         )`,
    )
    .bind(
      new Date().toISOString(),
      organizationId,
      checkoutGuard,
      organizationId,
    )
    .run();
  return Number(recovered.meta.changes) === 1;
}

async function cancelStripeSubscription(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_PRICE_ID" | "STRIPE_SECRET_KEY"
  >,
  organizationId: string,
  subscriptionId: string,
) {
  await withSubscriptionSyncLock(environment.DB, subscriptionId, async () => {
    const subscription = await deleteStripeSubscription(
      environment,
      subscriptionId,
    );
    await persistSubscription(
      environment,
      subscription,
      Math.floor(Date.now() / 1000),
      organizationId,
    );
  });
}

async function deleteStripeSubscription(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  subscriptionId: string,
) {
  const subscription = parseStripeSubscription(
    await stripeDelete(
      environment,
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    ),
  );
  if (subscription.status !== "canceled") {
    throw new StripeApiError("Stripe did not cancel the subscription.", 502);
  }
  return subscription;
}

async function resolvePendingCheckoutForDeletion(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  record: BillingRow | null,
) {
  if (!record?.pending_checkout_session_id) return null;
  const sessionId = record.pending_checkout_session_id;
  let session = parseStripeCheckoutSession(
    await stripeGet(
      environment,
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    ),
  );
  if (session.status === "open") {
    session = await expireOrReloadCheckoutSession(environment, sessionId);
  }
  if (session.status === "expired") return null;
  if (session.status === "complete") {
    const subscriptionId = optionalExpandableId(session.subscription);
    if (subscriptionId) return subscriptionId;
  }
  throw new StripeApiError(
    "Stripe Checkout could not be resolved before organization deletion.",
    409,
  );
}

async function expireOrReloadCheckoutSession(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  sessionId: string,
) {
  try {
    return parseStripeCheckoutSession(
      await stripePost(
        environment,
        `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
        new URLSearchParams(),
      ),
    );
  } catch (cause) {
    if (
      !(cause instanceof StripeApiError) ||
      (cause.status !== 400 && cause.status !== 409)
    ) {
      throw cause;
    }
    return parseStripeCheckoutSession(
      await stripeGet(
        environment,
        `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      ),
    );
  }
}

async function billingSummary(
  database: D1Database,
  organizationId: string,
  organizationRole: string,
  priceId: string | undefined,
  legacyPriceIds: string | undefined,
) {
  const [record, memberCount, formTemplateCount] = await Promise.all([
    findBilling(database, organizationId),
    countMembers(database, organizationId),
    countOrganizationTemplates(database, organizationId),
  ]);
  const pro = isPaidBilling(record, priceId, legacyPriceIds);
  return {
    billing: {
      cancelAtPeriodEnd: Boolean(record?.cancel_at_period_end),
      currentPeriodEnd: record?.current_period_end ?? null,
      status: record?.stripe_status ?? null,
    },
    canManage: canManageOrganization(organizationRole),
    current: {
      formTemplates: formTemplateCount,
      members: memberCount,
    },
    limits: pro
      ? { formTemplates: null, retentionDays: null, users: null }
      : {
          formTemplates: freeFormTemplateLimit,
          retentionDays: freeRetentionDays,
          users: 1,
        },
    plan: pro ? "pro" : "free",
    pricing: { currency: "usd", proMonthlyPerSeat: 1_000 },
    seats: pro ? Math.max(record?.seat_quantity ?? 1, memberCount) : 1,
  };
}

async function confirmCheckoutSession(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_PRICE_ID" | "STRIPE_SECRET_KEY"
  >,
  organizationId: string,
  sessionId: string,
) {
  const query = new URLSearchParams();
  query.append("expand[]", "subscription");
  const session = parseStripeCheckoutSession(
    await stripeGet(
      environment,
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      query,
    ),
  );
  if (
    session.client_reference_id !== organizationId ||
    session.status !== "complete"
  ) {
    throw new StripeApiError(
      "Checkout is not complete for this organization.",
      409,
    );
  }
  const subscriptionId = optionalExpandableId(session.subscription);
  if (!subscriptionId) {
    throw new StripeApiError("Checkout did not create a subscription.", 409);
  }
  const persisted = await refreshSubscription(
    environment,
    subscriptionId,
    Math.floor(Date.now() / 1000),
    organizationId,
    sessionId,
    session.metadata?.checkout_claim_id,
  );
  if (!persisted) {
    throw new StripeApiError("Checkout did not create a subscription.", 409);
  }
}

async function processStripeEvent(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_PRICE_ID" | "STRIPE_SECRET_KEY"
  >,
  event: StripeEvent,
) {
  if (event.type === "checkout.session.completed") {
    const session = parseStripeCheckoutSession(event.data.object);
    const organizationId =
      session.client_reference_id ?? session.metadata?.organization_id;
    if (!organizationId) return;
    const subscriptionId = optionalExpandableId(session.subscription);
    if (subscriptionId && session.id) {
      await refreshSubscription(
        environment,
        subscriptionId,
        event.created,
        organizationId,
        session.id,
        session.metadata?.checkout_claim_id,
      );
    }
    return;
  }
  if (event.type.startsWith("customer.subscription.")) {
    const subscriptionId = stripeObjectId(event.data.object, "sub_");
    await refreshSubscription(environment, subscriptionId, event.created);
    return;
  }
  if (
    event.type === "invoice.paid" ||
    event.type === "invoice.payment_failed"
  ) {
    const id = stripeInvoiceSubscriptionId(event.data.object);
    if (id) await refreshSubscription(environment, id, event.created);
  }
}

function stripeInvoiceSubscriptionId(value: unknown) {
  const invoice = stripeRecord(value, "Invoice");
  if (invoice.subscription !== undefined && invoice.subscription !== null) {
    return expandableId(stripeExpandable(invoice.subscription, "sub_"));
  }
  if (invoice.parent === undefined || invoice.parent === null) return null;
  const parent = stripeRecord(invoice.parent, "Invoice parent");
  if (
    parent.subscription_details === undefined ||
    parent.subscription_details === null
  ) {
    return null;
  }
  const details = stripeRecord(
    parent.subscription_details,
    "Invoice subscription details",
  );
  return details.subscription === undefined || details.subscription === null
    ? null
    : expandableId(stripeExpandable(details.subscription, "sub_"));
}

async function refreshSubscription(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_PRICE_ID" | "STRIPE_SECRET_KEY"
  >,
  subscriptionId: string,
  eventCreated: number,
  knownOrganizationId?: string,
  checkoutSessionId?: string,
  checkoutClaimId?: string,
) {
  const checkoutRefresh = Boolean(checkoutSessionId && knownOrganizationId);
  return withSubscriptionSyncLock(
    environment.DB,
    subscriptionId,
    async () => {
      if (
        checkoutSessionId &&
        knownOrganizationId &&
        (await checkoutSubscriptionAlreadyPersisted(
          environment.DB,
          knownOrganizationId,
          subscriptionId,
          checkoutClaimId,
        ))
      ) {
        return true;
      }
      const subscription = await expandedSubscription(
        environment,
        subscriptionId,
      );
      if (!subscription) return false;
      if (
        checkoutSessionId &&
        knownOrganizationId &&
        !(await prepareCheckoutSubscriptionReplacement(
          environment,
          knownOrganizationId,
          checkoutSessionId,
          checkoutClaimId,
          subscription,
        ))
      ) {
        return false;
      }
      const persisted = await persistSubscription(
        environment,
        subscription,
        eventCreated,
        knownOrganizationId,
        checkoutSessionId,
      );
      if (persisted || !checkoutSessionId || !knownOrganizationId) {
        return persisted;
      }
      return resolveRejectedCheckoutPersistence(
        environment,
        knownOrganizationId,
        subscription,
      );
    },
    checkoutRefresh,
  );
}

async function checkoutSubscriptionAlreadyPersisted(
  database: D1Database,
  organizationId: string,
  subscriptionId: string,
  checkoutClaimId: string | undefined,
) {
  const current = await findBilling(database, organizationId);
  const persisted =
    current?.stripe_subscription_id === subscriptionId &&
    !current.pending_checkout_session_id;
  if (persisted && checkoutClaimId) {
    await releaseCheckoutClaim(database, organizationId, checkoutClaimId);
  }
  return persisted;
}

async function prepareCheckoutSubscriptionReplacement(
  environment: Pick<
    Bindings,
    | "DB"
    | "STRIPE_PRO_LEGACY_PRICE_IDS"
    | "STRIPE_PRO_PRICE_ID"
    | "STRIPE_SECRET_KEY"
  >,
  organizationId: string,
  checkoutSessionId: string,
  checkoutClaimId: string | undefined,
  subscription: StripeSubscription,
) {
  await clearExpiredCheckoutDeletionLease(
    environment.DB,
    organizationId,
    Math.floor(Date.now() / 1_000),
  );
  if (checkoutClaimId) {
    await attachCheckoutSessionToClaim(
      environment.DB,
      organizationId,
      checkoutClaimId,
      checkoutSessionId,
    );
  }
  const existing = await findBilling(environment.DB, organizationId);
  const matchesCurrent = existing?.stripe_subscription_id === subscription.id;
  const matchesPending =
    existing?.pending_checkout_session_id === checkoutSessionId;
  const hasExpectedProEntitlement = Boolean(
    paidStatuses.has(subscription.status) &&
      findProSubscriptionItem(
        subscription,
        environment.STRIPE_PRO_PRICE_ID,
        environment.STRIPE_PRO_LEGACY_PRICE_IDS,
      ),
  );
  if (!hasExpectedProEntitlement) {
    if (!matchesCurrent) {
      await cancelUntrackedSubscription(environment, subscription);
    }
    if (matchesPending) {
      await clearPendingCheckoutIfCurrent(
        environment.DB,
        organizationId,
        checkoutSessionId,
      );
    }
    return false;
  }
  if (
    checkoutDeletionInProgress(existing, Math.floor(Date.now() / 1_000)) ||
    (!matchesPending &&
      (!matchesCurrent || Boolean(existing?.pending_checkout_session_id)))
  ) {
    if (!matchesCurrent) {
      await cancelUntrackedSubscription(environment, subscription);
    }
    return false;
  }
  if (
    existing.stripe_subscription_id &&
    existing.stripe_subscription_id !== subscription.id &&
    !terminalSubscriptionStatuses.has(existing.stripe_status ?? "")
  ) {
    await cancelStripeSubscription(
      environment,
      organizationId,
      existing.stripe_subscription_id,
    );
  }
  return true;
}

async function attachCheckoutSessionToClaim(
  database: D1Database,
  organizationId: string,
  claimId: string,
  sessionId: string,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET pending_checkout_session_id = ?, pending_checkout_url = NULL,
           pending_checkout_expires_at = checkout_claim_expires_at,
           pending_checkout_retry_at = NULL,
           checkout_claim_id = NULL, checkout_claim_customer_id = NULL,
           checkout_claim_price_id = NULL, checkout_claim_quantity = NULL,
           checkout_claim_expires_at = NULL, updated_at = ?
       WHERE organization_id = ? AND checkout_claim_id = ?
         AND checkout_disabled_at IS NULL`,
    )
    .bind(sessionId, new Date().toISOString(), organizationId, claimId)
    .run();
}

async function resolveRejectedCheckoutPersistence(
  environment: Pick<Bindings, "DB" | "STRIPE_SECRET_KEY">,
  organizationId: string,
  subscription: StripeSubscription,
) {
  const current = await findBilling(environment.DB, organizationId);
  if (
    current?.stripe_subscription_id === subscription.id &&
    !current.pending_checkout_session_id
  ) {
    return true;
  }
  if (current?.stripe_subscription_id !== subscription.id) {
    await cancelUntrackedSubscription(environment, subscription);
  }
  return false;
}

async function cancelUntrackedSubscription(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  subscription: StripeSubscription,
) {
  if (terminalSubscriptionStatuses.has(subscription.status)) return;
  try {
    await deleteStripeSubscription(environment, subscription.id);
  } catch (cause) {
    if (!(cause instanceof StripeApiError) || cause.status !== 404) throw cause;
  }
}

async function expandedSubscription(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  value: StripeExpandable | StripeSubscription | null,
) {
  if (!value) return null;
  if (typeof value === "object" && "items" in value) return value;
  const id = expandableId(value);
  return parseStripeSubscription(
    await stripeGet(environment, `/v1/subscriptions/${encodeURIComponent(id)}`),
  );
}

async function persistSubscription(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_LEGACY_PRICE_IDS" | "STRIPE_PRO_PRICE_ID"
  >,
  subscription: StripeSubscription,
  eventCreated: number,
  knownOrganizationId?: string,
  checkoutSessionId?: string,
) {
  const customerId = expandableId(subscription.customer);
  const organizationId =
    knownOrganizationId ??
    subscription.metadata?.organization_id ??
    (await organizationForStripeRecord(
      environment.DB,
      subscription.id,
      customerId,
    ));
  if (
    !organizationId ||
    !(await organizationExists(environment.DB, organizationId))
  ) {
    return false;
  }
  const item = findProSubscriptionItem(
    subscription,
    environment.STRIPE_PRO_PRICE_ID,
    environment.STRIPE_PRO_LEGACY_PRICE_IDS,
  );
  const periodEnd = item?.current_period_end ?? subscription.current_period_end;
  const cancelAtPeriodEnd =
    subscription.cancel_at_period_end === true ||
    subscription.cancel_at != null;
  if (checkoutSessionId) {
    const persisted = await environment.DB.prepare(
      `UPDATE organization_billing
       SET stripe_customer_id = ?, stripe_subscription_id = ?,
           stripe_subscription_item_id = ?, stripe_price_id = ?,
           stripe_status = ?, seat_quantity = ?, cancel_at_period_end = ?,
           current_period_end = ?,
           stripe_event_created = MAX(stripe_event_created, ?),
           checkout_claim_id = CASE
             WHEN pending_checkout_session_id = ? THEN NULL
             ELSE checkout_claim_id
           END,
           checkout_claim_customer_id = CASE
             WHEN pending_checkout_session_id = ? THEN NULL
             ELSE checkout_claim_customer_id
           END,
           checkout_claim_price_id = CASE
             WHEN pending_checkout_session_id = ? THEN NULL
             ELSE checkout_claim_price_id
           END,
           checkout_claim_quantity = CASE
             WHEN pending_checkout_session_id = ? THEN NULL
             ELSE checkout_claim_quantity
           END,
           checkout_claim_expires_at = CASE
             WHEN pending_checkout_session_id = ? THEN NULL
             ELSE checkout_claim_expires_at
           END,
           pending_checkout_session_id = CASE
             WHEN pending_checkout_session_id = ? THEN NULL
             ELSE pending_checkout_session_id
           END,
           pending_checkout_url = CASE
             WHEN pending_checkout_session_id = ? THEN NULL
             ELSE pending_checkout_url
           END,
           pending_checkout_expires_at = CASE
             WHEN pending_checkout_session_id = ? THEN NULL
             ELSE pending_checkout_expires_at
           END,
           pending_checkout_retry_at = CASE
             WHEN pending_checkout_session_id = ? THEN NULL
             ELSE pending_checkout_retry_at
           END,
           updated_at = ?
       WHERE organization_id = ? AND checkout_disabled_at IS NULL
         AND (pending_checkout_session_id = ?
              OR (stripe_subscription_id = ?
                  AND pending_checkout_session_id IS NULL))`,
    )
      .bind(
        customerId,
        subscription.id,
        item?.id ?? null,
        item?.price.id ?? null,
        subscription.status,
        Math.max(1, item?.quantity ?? 1),
        cancelAtPeriodEnd ? 1 : 0,
        periodEnd ? new Date(periodEnd * 1_000).toISOString() : null,
        eventCreated,
        checkoutSessionId,
        checkoutSessionId,
        checkoutSessionId,
        checkoutSessionId,
        checkoutSessionId,
        checkoutSessionId,
        checkoutSessionId,
        checkoutSessionId,
        checkoutSessionId,
        new Date().toISOString(),
        organizationId,
        checkoutSessionId,
        subscription.id,
      )
      .run();
    return Number(persisted.meta.changes) === 1;
  }
  const persisted = await environment.DB.prepare(
    `INSERT INTO organization_billing
     (organization_id, stripe_customer_id, stripe_subscription_id,
      stripe_subscription_item_id, stripe_price_id, stripe_status,
      seat_quantity, cancel_at_period_end, current_period_end,
      stripe_event_created, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (organization_id) DO UPDATE SET
       stripe_customer_id = excluded.stripe_customer_id,
       stripe_subscription_id = excluded.stripe_subscription_id,
       stripe_subscription_item_id = excluded.stripe_subscription_item_id,
       stripe_price_id = excluded.stripe_price_id,
       stripe_status = excluded.stripe_status,
       seat_quantity = excluded.seat_quantity,
       cancel_at_period_end = excluded.cancel_at_period_end,
       current_period_end = excluded.current_period_end,
       stripe_event_created = MAX(
         organization_billing.stripe_event_created,
         excluded.stripe_event_created
       ),
       updated_at = excluded.updated_at
     WHERE organization_billing.stripe_subscription_id IS NULL
        OR organization_billing.stripe_subscription_id =
           excluded.stripe_subscription_id`,
  )
    .bind(
      organizationId,
      customerId,
      subscription.id,
      item?.id ?? null,
      item?.price.id ?? null,
      subscription.status,
      Math.max(1, item?.quantity ?? 1),
      cancelAtPeriodEnd ? 1 : 0,
      periodEnd ? new Date(periodEnd * 1_000).toISOString() : null,
      eventCreated,
      new Date().toISOString(),
    )
    .run();
  return Number(persisted.meta.changes) === 1;
}

async function claimWebhookEvent(database: D1Database, event: StripeEvent) {
  const now = new Date().toISOString();
  const inserted = await database
    .prepare(
      `INSERT OR IGNORE INTO stripe_webhook_events
       (id, event_type, stripe_created, received_at, processed_at)
       VALUES (?, ?, ?, ?, NULL)`,
    )
    .bind(event.id, event.type, event.created, now)
    .run();
  if (Number(inserted.meta.changes) === 1) return "claimed" as const;
  const existing = await database
    .prepare(`SELECT processed_at FROM stripe_webhook_events WHERE id = ?`)
    .bind(event.id)
    .first<{ processed_at: string | null }>();
  if (existing?.processed_at) return "processed" as const;
  const staleBefore = new Date(
    Date.now() - webhookClaimTimeoutMilliseconds,
  ).toISOString();
  const reclaimed = await database
    .prepare(
      `UPDATE stripe_webhook_events SET received_at = ?
       WHERE id = ? AND processed_at IS NULL
         AND datetime(received_at) <= datetime(?)`,
    )
    .bind(now, event.id, staleBefore)
    .run();
  if (Number(reclaimed.meta.changes) === 1) return "claimed" as const;
  const completed = await database
    .prepare(`SELECT processed_at FROM stripe_webhook_events WHERE id = ?`)
    .bind(event.id)
    .first<{ processed_at: string | null }>();
  return completed?.processed_at
    ? ("processed" as const)
    : ("processing" as const);
}

async function organizationHasPro(
  database: D1Database,
  organizationId: string,
  priceId: string | undefined,
  legacyPriceIds?: string,
) {
  return isPaidBilling(
    await findBilling(database, organizationId),
    priceId,
    legacyPriceIds,
  );
}

function isPaidBilling(
  record: BillingRow | null,
  configuredPriceId: string | undefined,
  legacyPriceIds?: string,
) {
  return Boolean(
    record?.stripe_status &&
      paidStatuses.has(record.stripe_status) &&
      record.stripe_price_id &&
      configuredProPriceIds(configuredPriceId, legacyPriceIds).has(
        record.stripe_price_id,
      ),
  );
}

function isPaidBillingForEnvironment(
  record: BillingRow | null,
  environment: Pick<
    Bindings,
    "STRIPE_PRO_LEGACY_PRICE_IDS" | "STRIPE_PRO_PRICE_ID"
  >,
) {
  return isPaidBilling(
    record,
    environment.STRIPE_PRO_PRICE_ID,
    environment.STRIPE_PRO_LEGACY_PRICE_IDS,
  );
}

function configuredProPriceIds(
  currentPriceId: string | undefined,
  legacyPriceIds?: string,
) {
  const candidates = [currentPriceId, ...(legacyPriceIds?.split(",") ?? [])];
  return new Set(
    candidates
      .map((candidate) => candidate?.trim() ?? "")
      .filter(
        (candidate) =>
          candidate.startsWith("price_") && candidate.length <= 255,
      ),
  );
}

function findProSubscriptionItem(
  subscription: StripeSubscription,
  currentPriceId: string | undefined,
  legacyPriceIds?: string,
) {
  const allowedPriceIds = configuredProPriceIds(currentPriceId, legacyPriceIds);
  return subscription.items.data.find((item) =>
    allowedPriceIds.has(item.price.id),
  );
}

async function findBilling(database: D1Database, organizationId: string) {
  const statement = database.prepare(
    `SELECT stripe_customer_id, stripe_subscription_id,
            stripe_subscription_item_id, stripe_price_id, stripe_status,
            seat_quantity, cancel_at_period_end, current_period_end,
            stripe_event_created, checkout_claim_id,
            checkout_claim_customer_id, checkout_claim_price_id,
            checkout_claim_quantity,
            checkout_claim_expires_at,
            checkout_disabled_at, checkout_disabled_expires_at,
            pending_checkout_session_id, pending_checkout_url,
            pending_checkout_expires_at, pending_checkout_retry_at,
            last_reconciled_at, updated_at
     FROM organization_billing WHERE organization_id = ?`,
  );
  if (typeof statement.bind === "function") {
    return statement.bind(organizationId).first<BillingRow>();
  }
  return (
    statement as unknown as {
      get: (value: string) => BillingRow | null;
    }
  ).get(organizationId);
}

async function disableCheckoutForDeletion(
  database: D1Database,
  organizationId: string,
) {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const now = new Date(nowSeconds * 1_000).toISOString();
  const expiresAt = nowSeconds + checkoutDeletionLeaseSeconds;
  const checkoutGuard = crypto.randomUUID();
  const record = await database
    .prepare(
      `INSERT INTO organization_billing
       (organization_id, checkout_disabled_at,
        checkout_disabled_expires_at, updated_at)
       SELECT id, ?, ?, ? FROM organization WHERE id = ?
       ON CONFLICT (organization_id) DO UPDATE SET
         checkout_disabled_at = excluded.checkout_disabled_at,
         checkout_disabled_expires_at =
           excluded.checkout_disabled_expires_at,
         checkout_claim_id = NULL,
         checkout_claim_customer_id = NULL,
         checkout_claim_price_id = NULL,
         checkout_claim_quantity = NULL,
         checkout_claim_expires_at = NULL,
         updated_at = excluded.updated_at
       WHERE organization_billing.checkout_disabled_at IS NULL
          OR COALESCE(
               organization_billing.checkout_disabled_expires_at,
               0
             ) <= ?
       RETURNING stripe_customer_id, stripe_subscription_id,
                 stripe_subscription_item_id, stripe_price_id, stripe_status,
                 seat_quantity, cancel_at_period_end, current_period_end,
                 stripe_event_created, checkout_claim_id,
                 checkout_claim_customer_id, checkout_claim_price_id,
                 checkout_claim_quantity,
                 checkout_claim_expires_at,
                 checkout_disabled_at, checkout_disabled_expires_at,
                 pending_checkout_session_id,
                 pending_checkout_url, pending_checkout_expires_at,
                 pending_checkout_retry_at,
                 last_reconciled_at, updated_at`,
    )
    .bind(checkoutGuard, expiresAt, now, organizationId, nowSeconds)
    .first<BillingRow>();
  return record?.checkout_disabled_at === checkoutGuard
    ? { checkoutGuard, record }
    : null;
}

async function enableCheckoutAfterFailedDeletion(
  database: D1Database,
  organizationId: string,
  checkoutGuard: string | null,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET checkout_disabled_at = NULL,
           checkout_disabled_expires_at = NULL,
           updated_at = ?
       WHERE organization_id = ? AND checkout_disabled_at IS ?`,
    )
    .bind(new Date().toISOString(), organizationId, checkoutGuard)
    .run();
}

async function clearPendingCheckout(
  database: D1Database,
  organizationId: string,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET pending_checkout_session_id = NULL,
           pending_checkout_url = NULL,
           pending_checkout_expires_at = NULL,
           pending_checkout_retry_at = NULL,
           updated_at = ?
       WHERE organization_id = ?`,
    )
    .bind(new Date().toISOString(), organizationId)
    .run();
}

async function clearPendingCheckoutIfCurrent(
  database: D1Database,
  organizationId: string,
  sessionId: string,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET pending_checkout_session_id = NULL,
           pending_checkout_url = NULL,
           pending_checkout_expires_at = NULL,
           pending_checkout_retry_at = NULL,
           updated_at = ?
       WHERE organization_id = ? AND pending_checkout_session_id = ?`,
    )
    .bind(new Date().toISOString(), organizationId, sessionId)
    .run();
}

async function claimCheckout(
  database: D1Database,
  organizationId: string,
  priceId: string,
  quantity: number,
  nowSeconds: number,
) {
  const claimId = crypto.randomUUID();
  const expiresAt = nowSeconds + checkoutDurationSeconds;
  const claimed = await database
    .prepare(
      `INSERT INTO organization_billing
       (organization_id, checkout_claim_id, checkout_claim_customer_id,
        checkout_claim_price_id, checkout_claim_quantity,
        checkout_claim_expires_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT (organization_id) DO UPDATE SET
         checkout_claim_id = excluded.checkout_claim_id,
         checkout_claim_customer_id =
           organization_billing.stripe_customer_id,
         checkout_claim_price_id = excluded.checkout_claim_price_id,
         checkout_claim_quantity = excluded.checkout_claim_quantity,
         checkout_claim_expires_at = excluded.checkout_claim_expires_at,
         checkout_disabled_at = NULL,
         checkout_disabled_expires_at = NULL,
         updated_at = excluded.updated_at
       WHERE NOT (
           COALESCE(organization_billing.stripe_price_id, '') = ?
           AND COALESCE(organization_billing.stripe_status, '') IN
             ('active', 'past_due', 'trialing')
         )
         AND COALESCE(organization_billing.pending_checkout_expires_at, 0) <= ?
         AND COALESCE(organization_billing.checkout_claim_expires_at, 0) <= ?
         AND (
           organization_billing.checkout_disabled_at IS NULL
           OR COALESCE(
                organization_billing.checkout_disabled_expires_at,
                0
              ) <= ?
         )`,
    )
    .bind(
      organizationId,
      claimId,
      priceId,
      quantity,
      expiresAt,
      new Date().toISOString(),
      priceId,
      nowSeconds,
      nowSeconds,
      nowSeconds,
    )
    .run();
  const record = await findBilling(database, organizationId);
  return {
    id: claimId,
    owned:
      Number(claimed.meta.changes) === 1 &&
      record?.checkout_claim_id === claimId,
    record,
  };
}

function completeCheckoutClaim(
  record: BillingRow | null,
  claimId: string,
): record is BillingRow & {
  checkout_claim_expires_at: number;
  checkout_claim_id: string;
  checkout_claim_price_id: string;
  checkout_claim_quantity: number;
} {
  return Boolean(
    record?.checkout_claim_id === claimId &&
      record.checkout_claim_price_id &&
      record.checkout_claim_quantity &&
      record.checkout_claim_expires_at,
  );
}

async function prepareCheckoutState(
  context: Context<BillingEnv>,
  organizationId: string,
) {
  let state = await checkoutState(context.env.DB, organizationId);
  const existingResponse = checkoutStateResponse(context, state);
  if (existingResponse) return existingResponse;
  const staleSessionId = stalePendingCheckoutId(
    state.billingRecord,
    state.nowSeconds,
  );
  if (!staleSessionId) return state;
  try {
    await reconcilePendingCheckoutEntitlement(
      context.env,
      organizationId,
      staleSessionId,
      state.nowSeconds,
    );
  } catch (cause) {
    return billingError(context, cause);
  }
  state = await checkoutState(context.env.DB, organizationId);
  return checkoutStateResponse(context, state) ?? state;
}

function checkoutStateResponse(
  context: Context<BillingEnv>,
  state: Awaited<ReturnType<typeof checkoutState>>,
) {
  if (checkoutDeletionInProgress(state.billingRecord, state.nowSeconds)) {
    return checkoutDisabledResponse(context);
  }
  if (isPaidBillingForEnvironment(state.billingRecord, context.env)) {
    return alreadyProResponse(context);
  }
  const pending = activePendingCheckout(state.billingRecord, state.nowSeconds);
  return pending ? context.json({ url: pending.url }) : null;
}

async function checkoutState(database: D1Database, organizationId: string) {
  const [billingRecord, memberCount] = await Promise.all([
    findBilling(database, organizationId),
    countMembers(database, organizationId),
  ]);
  return {
    billingRecord,
    memberCount,
    nowSeconds: Math.floor(Date.now() / 1_000),
  };
}

async function clearExpiredCheckoutDeletionLease(
  database: D1Database,
  organizationId: string,
  nowSeconds: number,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET checkout_disabled_at = NULL,
           checkout_disabled_expires_at = NULL,
           updated_at = ?
       WHERE organization_id = ?
         AND checkout_disabled_at IS NOT NULL
         AND COALESCE(checkout_disabled_expires_at, 0) <= ?`,
    )
    .bind(
      new Date(nowSeconds * 1_000).toISOString(),
      organizationId,
      nowSeconds,
    )
    .run();
}

function checkoutDeletionInProgress(
  record: BillingRow | null,
  nowSeconds: number,
) {
  return Boolean(
    record?.checkout_disabled_at &&
      record.checkout_disabled_expires_at &&
      record.checkout_disabled_expires_at > nowSeconds,
  );
}

async function releaseCheckoutClaim(
  database: D1Database,
  organizationId: string,
  claimId: string,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET checkout_claim_id = NULL,
           checkout_claim_customer_id = NULL,
           checkout_claim_price_id = NULL,
           checkout_claim_quantity = NULL,
           checkout_claim_expires_at = NULL,
           updated_at = ?
       WHERE organization_id = ? AND checkout_claim_id = ?`,
    )
    .bind(new Date().toISOString(), organizationId, claimId)
    .run();
}

function activePendingCheckout(record: BillingRow | null, nowSeconds: number) {
  if (
    !record?.pending_checkout_session_id ||
    !record.pending_checkout_url ||
    !record.pending_checkout_expires_at ||
    record.pending_checkout_expires_at <= nowSeconds
  ) {
    return null;
  }
  return {
    id: record.pending_checkout_session_id,
    url: record.pending_checkout_url,
  };
}

function stalePendingCheckoutId(record: BillingRow | null, nowSeconds: number) {
  return record?.pending_checkout_session_id &&
    (record.pending_checkout_expires_at ?? 0) <= nowSeconds
    ? record.pending_checkout_session_id
    : null;
}

function validCreatedCheckout(checkout: StripeCheckoutSession) {
  return Boolean(
    checkout.status === "open" &&
      checkout.url &&
      checkout.id &&
      checkout.expires_at,
  );
}

function checkoutParameters(
  origin: string,
  organizationId: string,
  priceId: string,
  claim: BillingRow & { checkout_claim_id: string },
) {
  const parameters = new URLSearchParams({
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": String(claim.checkout_claim_quantity),
    "metadata[checkout_claim_id]": claim.checkout_claim_id,
    "metadata[organization_id]": organizationId,
    "subscription_data[metadata][checkout_claim_id]": claim.checkout_claim_id,
    "subscription_data[metadata][organization_id]": organizationId,
    cancel_url: `${origin}/organization/billing?checkout=canceled`,
    client_reference_id: organizationId,
    expires_at: String(claim.checkout_claim_expires_at),
    mode: "subscription",
    success_url: `${origin}/organization/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
  });
  if (claim.checkout_claim_customer_id) {
    parameters.set("customer", claim.checkout_claim_customer_id);
  }
  return parameters;
}

async function storePendingCheckout(
  database: D1Database,
  organizationId: string,
  claimId: string,
  checkout: StripeCheckoutSession,
) {
  const stored = await database
    .prepare(
      `UPDATE organization_billing
       SET pending_checkout_session_id = ?, pending_checkout_url = ?,
           pending_checkout_expires_at = ?, pending_checkout_retry_at = NULL,
           checkout_claim_id = NULL,
           checkout_claim_customer_id = NULL,
           checkout_claim_price_id = NULL, checkout_claim_quantity = NULL,
           checkout_claim_expires_at = NULL,
           updated_at = ?
       WHERE organization_id = ?
         AND (checkout_claim_id = ? OR pending_checkout_session_id = ?)`,
    )
    .bind(
      checkout.id,
      checkout.url,
      checkout.expires_at,
      new Date().toISOString(),
      organizationId,
      claimId,
      checkout.id,
    )
    .run();
  return Number(stored.meta.changes) === 1;
}

async function expireCheckoutSession(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  sessionId: string,
) {
  parseStripeCheckoutSession(
    await stripePost(
      environment,
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
      new URLSearchParams(),
    ),
  );
}

async function countMembers(database: D1Database, organizationId: string) {
  const row = await database
    .prepare(`SELECT COUNT(*) AS count FROM member WHERE organizationId = ?`)
    .bind(organizationId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function countOrganizationTemplates(
  database: D1Database,
  organizationId: string,
) {
  const row = await database
    .prepare(
      `SELECT COUNT(*) AS count FROM audit_template_families
       WHERE scope = 'organization' AND organization_id = ?`,
    )
    .bind(organizationId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

async function organizationForStripeRecord(
  database: D1Database,
  subscriptionId: string,
  customerId: string,
) {
  const row = await database
    .prepare(
      `SELECT organization_id FROM organization_billing
       WHERE stripe_subscription_id = ? OR stripe_customer_id = ?
       LIMIT 1`,
    )
    .bind(subscriptionId, customerId)
    .first<{ organization_id: string }>();
  return row?.organization_id;
}

async function organizationExists(
  database: D1Database,
  organizationId: string,
) {
  return Boolean(
    await database
      .prepare(`SELECT id FROM organization WHERE id = ? AND deletedAt IS NULL`)
      .bind(organizationId)
      .first(),
  );
}

async function updateStoredSeatQuantity(
  database: D1Database,
  organizationId: string,
  subscriptionItemId: string,
  quantity: number,
) {
  await database
    .prepare(
      `UPDATE organization_billing
       SET seat_quantity = ?, updated_at = ?
       WHERE organization_id = ? AND stripe_subscription_item_id = ?`,
    )
    .bind(
      quantity,
      new Date().toISOString(),
      organizationId,
      subscriptionItemId,
    )
    .run();
}

async function withSubscriptionSyncLock<T>(
  database: D1Database,
  subscriptionId: string,
  action: () => Promise<T>,
  waitForLock = false,
) {
  const claimId = crypto.randomUUID();
  await claimSubscriptionSyncLock(
    database,
    subscriptionId,
    claimId,
    waitForLock,
  );
  try {
    return await action();
  } finally {
    await database
      .prepare(
        `DELETE FROM stripe_subscription_sync_locks
         WHERE subscription_id = ? AND claim_id = ?`,
      )
      .bind(subscriptionId, claimId)
      .run();
  }
}

async function claimSubscriptionSyncLock(
  database: D1Database,
  subscriptionId: string,
  claimId: string,
  waitForLock: boolean,
) {
  const waitDeadline = Date.now() + 10_000;
  while (true) {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const claimed = await database
      .prepare(
        `INSERT INTO stripe_subscription_sync_locks
         (subscription_id, claim_id, claim_expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT (subscription_id) DO UPDATE SET
           claim_id = excluded.claim_id,
           claim_expires_at = excluded.claim_expires_at
         WHERE stripe_subscription_sync_locks.claim_expires_at <= ?`,
      )
      .bind(
        subscriptionId,
        claimId,
        nowSeconds + subscriptionSyncClaimSeconds,
        nowSeconds,
      )
      .run();
    if (Number(claimed.meta.changes) === 1) return;
    if (!waitForLock || Date.now() >= waitDeadline) {
      throw new Error(
        "Stripe subscription synchronization is already running.",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function optionalExpandableId(value: StripeExpandable | null) {
  return value ? expandableId(value) : null;
}

function expandableId(value: StripeExpandable) {
  return typeof value === "string" ? value : value.id;
}

function parseStripeCheckoutSession(value: unknown): StripeCheckoutSession {
  const record = stripeRecord(value, "Checkout session");
  const session: StripeCheckoutSession = {
    client_reference_id: stripeNullableString(
      record.client_reference_id,
      "Checkout client reference",
    ),
    customer: stripeOptionalExpandable(record.customer, "cus_"),
    id: stripeString(record.id, "Checkout session ID", "cs_"),
    status: stripeNullableString(record.status, "Checkout status"),
    subscription: stripeOptionalSubscription(record.subscription),
  };
  const expiresAt = stripeOptionalInteger(
    record.expires_at,
    "Checkout expiration",
  );
  if (expiresAt !== undefined) session.expires_at = expiresAt;
  const metadata = stripeOptionalMetadata(record.metadata);
  if (metadata) session.metadata = metadata;
  const url = stripeOptionalNullableString(record.url, "Checkout URL");
  if (url !== undefined) session.url = url;
  return session;
}

function parseStripeSubscription(value: unknown): StripeSubscription {
  const record = stripeRecord(value, "Subscription");
  const items = stripeRecord(record.items, "Subscription items").data;
  if (!Array.isArray(items)) {
    throw malformedStripeResponse("Subscription items");
  }
  const subscription: StripeSubscription = {
    customer: stripeExpandable(record.customer, "cus_"),
    id: stripeString(record.id, "Subscription ID", "sub_"),
    items: { data: items.map((item) => parseStripeSubscriptionItem(item)) },
    status: stripeString(record.status, "Subscription status"),
  };
  if (record.cancel_at === null) {
    subscription.cancel_at = null;
  } else {
    const cancelAt = stripeOptionalInteger(
      record.cancel_at,
      "Subscription cancel",
    );
    if (cancelAt !== undefined) subscription.cancel_at = cancelAt;
  }
  const cancelAtPeriodEnd = stripeOptionalBoolean(
    record.cancel_at_period_end,
    "Subscription cancellation",
  );
  if (cancelAtPeriodEnd !== undefined) {
    subscription.cancel_at_period_end = cancelAtPeriodEnd;
  }
  const periodEnd = stripeOptionalInteger(
    record.current_period_end,
    "Subscription period end",
  );
  if (periodEnd !== undefined) subscription.current_period_end = periodEnd;
  const metadata = stripeOptionalMetadata(record.metadata);
  if (metadata) subscription.metadata = metadata;
  return subscription;
}

function parseStripeSubscriptionItem(value: unknown): StripeSubscriptionItem {
  const record = stripeRecord(value, "Subscription item");
  const price = stripeRecord(record.price, "Subscription item price");
  const item: StripeSubscriptionItem = {
    id: stripeString(record.id, "Subscription item ID", "si_"),
    price: { id: stripeString(price.id, "Stripe price ID", "price_") },
  };
  const periodEnd = stripeOptionalInteger(
    record.current_period_end,
    "Subscription item period end",
  );
  if (periodEnd !== undefined) item.current_period_end = periodEnd;
  const quantity = stripeOptionalInteger(
    record.quantity,
    "Subscription item quantity",
  );
  if (quantity !== undefined && quantity < 1) {
    throw malformedStripeResponse("Subscription item quantity");
  }
  if (quantity !== undefined) item.quantity = quantity;
  return item;
}

function parseStripeSeatItemResponse(value: unknown): StripeSeatItemResponse {
  const record = stripeRecord(value, "Subscription item");
  const quantity = stripeOptionalInteger(
    record.quantity,
    "Subscription item quantity",
  );
  if (quantity === undefined || quantity < 1) {
    throw malformedStripeResponse("Subscription item quantity");
  }
  return {
    id: stripeString(record.id, "Subscription item ID", "si_"),
    quantity,
  };
}

function parseStripePortalSession(value: unknown) {
  const record = stripeRecord(value, "Billing Portal session");
  return {
    url: stripeString(record.url, "Billing Portal URL", "https://"),
  };
}

function stripeOptionalSubscription(
  value: unknown,
): StripeExpandable | StripeSubscription | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "object" && value !== null && "items" in value) {
    return parseStripeSubscription(value);
  }
  return stripeExpandable(value, "sub_");
}

function stripeOptionalExpandable(
  value: unknown,
  prefix: string,
): StripeExpandable | null {
  if (value === undefined || value === null) return null;
  return stripeExpandable(value, prefix);
}

function stripeExpandable(value: unknown, prefix: string): StripeExpandable {
  if (typeof value === "string") {
    return stripeString(value, "Stripe object ID", prefix);
  }
  const record = stripeRecord(value, "Expandable Stripe object");
  return { id: stripeString(record.id, "Stripe object ID", prefix) };
}

function stripeObjectId(value: unknown, prefix: string) {
  return stripeString(
    stripeRecord(value, "Stripe event object").id,
    "Stripe event object ID",
    prefix,
  );
}

function stripeRecord(value: unknown, label: string): StripePayloadRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw malformedStripeResponse(label);
  }
  return value as StripePayloadRecord;
}

function stripeString(value: unknown, label: string, prefix?: string) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    (prefix !== undefined && !value.startsWith(prefix))
  ) {
    throw malformedStripeResponse(label);
  }
  return value;
}

function stripeNullableString(value: unknown, label: string) {
  if (value === undefined || value === null) return null;
  return stripeString(value, label);
}

function stripeOptionalNullableString(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return stripeString(value, label);
}

function stripeOptionalInteger(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value)) throw malformedStripeResponse(label);
  return value as number;
}

function stripeOptionalBoolean(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw malformedStripeResponse(label);
  return value;
}

function stripeOptionalMetadata(value: unknown) {
  if (value === undefined) return undefined;
  const record = stripeRecord(value, "Stripe metadata");
  const metadata: Record<string, string> = {};
  for (const [key, field] of Object.entries(record)) {
    metadata[key] = stripeString(field, "Stripe metadata value");
  }
  return metadata;
}

function malformedStripeResponse(label: string) {
  return new StripeApiError(`Stripe returned a malformed ${label}.`, 502);
}

function validEvent(value: StripeEvent) {
  return (
    typeof value?.id === "string" &&
    value.id.startsWith("evt_") &&
    typeof value.type === "string" &&
    Number.isSafeInteger(value.created) &&
    typeof value.data === "object" &&
    value.data !== null
  );
}

function billingError(context: Context<BillingEnv>, cause: unknown) {
  if (cause instanceof StripeConfigurationError) {
    return context.json({ error: cause.message }, 503);
  }
  if (cause instanceof StripeApiError) {
    console.error("Stripe billing request failed", cause.status, cause.message);
    const status = cause.status === 409 ? 409 : 502;
    return context.json({ error: cause.message }, status);
  }
  throw cause;
}

async function checkoutCreationError(
  context: Context<BillingEnv>,
  cause: unknown,
  organizationId: string,
  claimId: string,
) {
  if (
    cause instanceof StripeConfigurationError ||
    (cause instanceof StripeApiError && cause.status < 500)
  ) {
    await releaseCheckoutClaim(context.env.DB, organizationId, claimId);
  }
  return billingError(context, cause);
}

function checkoutDisabledResponse(context: Context<BillingEnv>) {
  return context.json(
    {
      error:
        "Checkout is unavailable while this organization is being deleted.",
    },
    409,
  );
}

function billingUnavailableResponse(context: Context<BillingEnv>) {
  return context.json({ error: "Stripe billing is not configured." }, 503);
}

function checkoutInProgressResponse(context: Context<BillingEnv>) {
  return context.json(
    { error: "Checkout is already being prepared. Try again shortly." },
    409,
  );
}

function alreadyProResponse(context: Context<BillingEnv>) {
  return context.json(
    { error: "This organization already has a Pro subscription." },
    409,
  );
}

export { billing };
