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

export const freeFormTemplateLimit = 5;
export const freeRetentionDays = 30;
const unlimitedSeatLimit = Number.MAX_SAFE_INTEGER;
const paidStatuses = new Set(["active", "past_due", "trialing"]);
const webhookClaimTimeoutMilliseconds = 5 * 60 * 1000;
const checkoutDurationSeconds = 35 * 60;
const subscriptionSyncClaimSeconds = 2 * 60;

type BillingEnv = {
  Bindings: Bindings;
  Variables: AuthVariables;
};

interface BillingRow {
  cancel_at_period_end: number;
  checkout_claim_expires_at: number | null;
  checkout_claim_id: string | null;
  checkout_claim_quantity: number | null;
  current_period_end: string | null;
  last_reconciled_at: string | null;
  pending_checkout_expires_at: number | null;
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
  metadata?: { organization_id?: string; [key: string]: string | undefined };
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

interface StripeSubscription {
  cancel_at?: number | null;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  customer: StripeExpandable;
  id: string;
  items: { data: StripeSubscriptionItem[] };
  metadata?: { organization_id?: string; [key: string]: string | undefined };
  status: string;
}

interface StripeEvent {
  created: number;
  data: { object: unknown };
  id: string;
  type: string;
}

type StripeExpandable = string | { id: string };

const billing = new Hono<BillingEnv>();

billing.get("/", async (context) => {
  const organizationId = context.get("organizationId");
  const sessionId = context.req.query("session_id");
  if (sessionId) {
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
  if (!priceId) {
    return context.json({ error: "Stripe billing is not configured." }, 503);
  }
  const [billingRecord, memberCount] = await Promise.all([
    findBilling(context.env.DB, organizationId),
    countMembers(context.env.DB, organizationId),
  ]);
  if (isPaidBilling(billingRecord, priceId)) {
    return context.json(
      { error: "This organization already has a Pro subscription." },
      409,
    );
  }
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const pendingCheckout = activePendingCheckout(billingRecord, nowSeconds);
  if (pendingCheckout) return context.json({ url: pendingCheckout.url });
  const claimedBilling = await claimCheckout(
    context.env.DB,
    organizationId,
    priceId,
    Math.max(1, memberCount),
    nowSeconds,
  );
  if (isPaidBilling(claimedBilling, priceId)) {
    return context.json(
      { error: "This organization already has a Pro subscription." },
      409,
    );
  }
  const claimedPending = activePendingCheckout(claimedBilling, nowSeconds);
  if (claimedPending) return context.json({ url: claimedPending.url });
  if (
    !claimedBilling?.checkout_claim_id ||
    !claimedBilling.checkout_claim_quantity ||
    !claimedBilling.checkout_claim_expires_at
  ) {
    return context.json(
      { error: "Checkout is already being prepared. Try again shortly." },
      409,
    );
  }
  const parameters = new URLSearchParams({
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": String(claimedBilling.checkout_claim_quantity),
    "metadata[organization_id]": organizationId,
    "subscription_data[metadata][organization_id]": organizationId,
    cancel_url: `${context.env.CORS_ORIGIN}/organization/billing?checkout=canceled`,
    client_reference_id: organizationId,
    expires_at: String(claimedBilling.checkout_claim_expires_at),
    mode: "subscription",
    success_url: `${context.env.CORS_ORIGIN}/organization/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
  });
  if (billingRecord?.stripe_customer_id) {
    parameters.delete("customer_email");
    parameters.set("customer", billingRecord.stripe_customer_id);
  }
  try {
    const checkout = await stripePost<StripeCheckoutSession>(
      context.env,
      "/v1/checkout/sessions",
      parameters,
      `checkout:${organizationId}:${claimedBilling.checkout_claim_id}`,
    );
    if (!checkout.url || !checkout.id || !checkout.expires_at) {
      throw new Error("Stripe did not return a checkout URL.");
    }
    const stored = await storePendingCheckout(
      context.env.DB,
      organizationId,
      claimedBilling.checkout_claim_id,
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
    return billingError(context, cause);
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
    const portal = await stripePost<{ url?: string }>(
      context.env,
      "/v1/billing_portal/sessions",
      parameters,
    );
    if (!portal.url) throw new Error("Stripe did not return a portal URL.");
    return context.json({ url: portal.url });
  } catch (cause) {
    return billingError(context, cause);
  }
});

export async function handleStripeWebhook(context: Context<BillingEnv>) {
  const payload = await context.req.arrayBuffer();
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
  if (!claimed) return context.json({ received: true });
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
) {
  return (await organizationHasPro(database, organizationId, priceId))
    ? unlimitedSeatLimit
    : 1;
}

export async function organizationInvitationLimit(
  database: D1Database,
  organizationId: string,
  priceId: string | undefined,
) {
  return (await organizationHasPro(database, organizationId, priceId))
    ? unlimitedSeatLimit
    : 0;
}

export async function organizationTemplateLimit(
  database: D1Database,
  organizationId: string,
  priceId: string | undefined,
) {
  return (await organizationHasPro(database, organizationId, priceId))
    ? null
    : freeFormTemplateLimit;
}

export async function organizationUserHasSeat(
  database: D1Database,
  organizationId: string,
  userId: string,
  priceId: string | undefined,
) {
  if (await organizationHasPro(database, organizationId, priceId)) return true;
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
    "DB" | "STRIPE_PRO_PRICE_ID" | "STRIPE_SECRET_KEY"
  >,
  organizationId: string,
  verifyStripeQuantity = false,
) {
  const record = await findBilling(environment.DB, organizationId);
  if (
    !isPaidBilling(record, environment.STRIPE_PRO_PRICE_ID) ||
    !record?.stripe_subscription_item_id
  ) {
    return false;
  }
  const quantity = Math.max(
    1,
    await countMembers(environment.DB, organizationId),
  );
  if (quantity === record.seat_quantity && !verifyStripeQuantity) return false;
  if (verifyStripeQuantity) {
    const stripeItem = await stripeGet<StripeSubscriptionItem>(
      environment,
      `/v1/subscription_items/${encodeURIComponent(record.stripe_subscription_item_id)}`,
    );
    if (Math.max(1, stripeItem.quantity ?? 1) === quantity) {
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
  );
  await updateStoredSeatQuantity(
    environment.DB,
    organizationId,
    record.stripe_subscription_item_id,
    quantity,
  );
  return true;
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
     ORDER BY COALESCE(last_reconciled_at, '') ASC, organization_id ASC
     LIMIT 25`,
  ).all<{ organization_id: string }>();
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

export async function cancelOrganizationSubscription(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_PRICE_ID" | "STRIPE_SECRET_KEY"
  >,
  organizationId: string,
) {
  const record = await findBilling(environment.DB, organizationId);
  if (!record?.stripe_subscription_id || record.stripe_status === "canceled") {
    return false;
  }
  const subscriptionId = record.stripe_subscription_id;
  await withSubscriptionSyncLock(environment.DB, subscriptionId, async () => {
    const subscription = await stripeDelete<StripeSubscription>(
      environment,
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
    );
    await persistSubscription(
      environment,
      subscription,
      Math.floor(Date.now() / 1000),
      organizationId,
    );
  });
  return true;
}

async function billingSummary(
  database: D1Database,
  organizationId: string,
  organizationRole: string,
  priceId: string | undefined,
) {
  const [record, memberCount, formTemplateCount] = await Promise.all([
    findBilling(database, organizationId),
    countMembers(database, organizationId),
    countOrganizationTemplates(database, organizationId),
  ]);
  const pro = isPaidBilling(record, priceId);
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
  const session = await stripeGet<StripeCheckoutSession>(
    environment,
    `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
    query,
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
    const session = event.data.object as StripeCheckoutSession;
    const organizationId =
      session.client_reference_id ?? session.metadata?.organization_id;
    if (!organizationId) return;
    const subscriptionId = optionalExpandableId(session.subscription);
    if (subscriptionId) {
      await refreshSubscription(
        environment,
        subscriptionId,
        event.created,
        organizationId,
      );
    }
    return;
  }
  if (event.type.startsWith("customer.subscription.")) {
    const eventSubscription = event.data.object as StripeSubscription;
    await refreshSubscription(environment, eventSubscription.id, event.created);
    return;
  }
  if (
    event.type === "invoice.paid" ||
    event.type === "invoice.payment_failed"
  ) {
    const invoice = event.data.object as {
      parent?: { subscription_details?: { subscription?: StripeExpandable } };
      subscription?: StripeExpandable;
    };
    const subscriptionId =
      invoice.parent?.subscription_details?.subscription ??
      invoice.subscription;
    const id = optionalExpandableId(subscriptionId ?? null);
    if (id) await refreshSubscription(environment, id, event.created);
  }
}

async function refreshSubscription(
  environment: Pick<
    Bindings,
    "DB" | "STRIPE_PRO_PRICE_ID" | "STRIPE_SECRET_KEY"
  >,
  subscriptionId: string,
  eventCreated: number,
  knownOrganizationId?: string,
) {
  return withSubscriptionSyncLock(environment.DB, subscriptionId, async () => {
    const subscription = await expandedSubscription(
      environment,
      subscriptionId,
    );
    if (!subscription) return false;
    return persistSubscription(
      environment,
      subscription,
      eventCreated,
      knownOrganizationId,
    );
  });
}

async function expandedSubscription(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  value: StripeExpandable | StripeSubscription | null,
) {
  if (!value) return null;
  if (typeof value === "object" && "items" in value) return value;
  const id = expandableId(value);
  return stripeGet<StripeSubscription>(
    environment,
    `/v1/subscriptions/${encodeURIComponent(id)}`,
  );
}

async function persistSubscription(
  environment: Pick<Bindings, "DB" | "STRIPE_PRO_PRICE_ID">,
  subscription: StripeSubscription,
  eventCreated: number,
  knownOrganizationId?: string,
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
  const item = subscription.items.data.find(
    (candidate) => candidate.price.id === environment.STRIPE_PRO_PRICE_ID,
  );
  const periodEnd = item?.current_period_end ?? subscription.current_period_end;
  const cancelAtPeriodEnd =
    subscription.cancel_at_period_end === true ||
    subscription.cancel_at != null;
  await environment.DB.prepare(
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
       checkout_claim_id = NULL,
       checkout_claim_quantity = NULL,
       checkout_claim_expires_at = NULL,
       pending_checkout_session_id = NULL,
       pending_checkout_url = NULL,
       pending_checkout_expires_at = NULL,
       updated_at = excluded.updated_at`,
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
  return true;
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
  if (Number(inserted.meta.changes) === 1) return true;
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
  return Number(reclaimed.meta.changes) === 1;
}

async function organizationHasPro(
  database: D1Database,
  organizationId: string,
  priceId: string | undefined,
) {
  return isPaidBilling(await findBilling(database, organizationId), priceId);
}

function isPaidBilling(
  record: BillingRow | null,
  expectedPriceId: string | undefined,
) {
  return Boolean(
    expectedPriceId &&
      record?.stripe_status &&
      paidStatuses.has(record.stripe_status) &&
      record.stripe_price_id === expectedPriceId,
  );
}

async function findBilling(database: D1Database, organizationId: string) {
  const statement = database.prepare(
    `SELECT stripe_customer_id, stripe_subscription_id,
            stripe_subscription_item_id, stripe_price_id, stripe_status,
            seat_quantity, cancel_at_period_end, current_period_end,
            stripe_event_created, checkout_claim_id,
            checkout_claim_quantity, checkout_claim_expires_at,
            pending_checkout_session_id, pending_checkout_url,
            pending_checkout_expires_at, last_reconciled_at, updated_at
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

async function claimCheckout(
  database: D1Database,
  organizationId: string,
  priceId: string,
  quantity: number,
  nowSeconds: number,
) {
  const claimId = crypto.randomUUID();
  const expiresAt = nowSeconds + checkoutDurationSeconds;
  await database
    .prepare(
      `INSERT INTO organization_billing
       (organization_id, checkout_claim_id, checkout_claim_quantity,
        checkout_claim_expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (organization_id) DO UPDATE SET
         checkout_claim_id = excluded.checkout_claim_id,
         checkout_claim_quantity = excluded.checkout_claim_quantity,
         checkout_claim_expires_at = excluded.checkout_claim_expires_at,
         updated_at = excluded.updated_at
       WHERE NOT (
           COALESCE(organization_billing.stripe_price_id, '') = ?
           AND COALESCE(organization_billing.stripe_status, '') IN
             ('active', 'past_due', 'trialing')
         )
         AND COALESCE(organization_billing.pending_checkout_expires_at, 0) <= ?
         AND COALESCE(organization_billing.checkout_claim_expires_at, 0) <= ?`,
    )
    .bind(
      organizationId,
      claimId,
      quantity,
      expiresAt,
      new Date().toISOString(),
      priceId,
      nowSeconds,
      nowSeconds,
    )
    .run();
  return findBilling(database, organizationId);
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
           pending_checkout_expires_at = ?, checkout_claim_id = NULL,
           checkout_claim_quantity = NULL, checkout_claim_expires_at = NULL,
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
  await stripePost(
    environment,
    `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/expire`,
    new URLSearchParams(),
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
) {
  const claimId = crypto.randomUUID();
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
  if (Number(claimed.meta.changes) !== 1) {
    throw new Error("Stripe subscription synchronization is already running.");
  }
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

function optionalExpandableId(value: StripeExpandable | null) {
  return value ? expandableId(value) : null;
}

function expandableId(value: StripeExpandable) {
  return typeof value === "string" ? value : value.id;
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

export { billing };
