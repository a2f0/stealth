import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import {
  billing,
  cancelOrganizationSubscription,
  handleStripeWebhook,
  reconcileSubscriptionSeats,
  syncOrganizationSeats,
} from "./billing";
import { purgeExpiredFreeAuditRuns } from "./billingRetention";
import type { Bindings } from "./types";

const organizationId = "org_user-1";
const proPriceId = "price_pro_test";

describe("billing", () => {
  it("requires billing access to confirm a Checkout session", async () => {
    const fixture = await createFixture("member");
    expect(
      (
        await fixture.app.request(
          "/?session_id=cs_completed",
          undefined,
          fixture.bindings,
        )
      ).status,
    ).toBe(403);
  });

  it("reports Free entitlements and creates per-seat Checkout", async () => {
    const fixture = await createFixture();
    const summary = await fixture.app.request("/", undefined, fixture.bindings);
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      current: { formTemplates: 0, members: 1 },
      limits: { formTemplates: 5, retentionDays: 30, users: 1 },
      plan: "free",
      pricing: { currency: "usd", proMonthlyPerSeat: 1_000 },
      seats: 1,
    });

    const originalFetch = globalThis.fetch;
    const checkoutRequests: URLSearchParams[] = [];
    globalThis.fetch = (async (_input, init) => {
      checkoutRequests.push(new URLSearchParams(String(init?.body)));
      return Response.json({
        client_reference_id: organizationId,
        expires_at: Math.floor(Date.now() / 1_000) + 1_800,
        id: "cs_live_test",
        status: "open",
        url: "https://checkout.stripe.test/session",
      });
    }) as typeof fetch;
    try {
      const response = await fixture.app.request(
        "/checkout",
        { method: "POST" },
        fixture.bindings,
      );
      expect(response.status).toBe(200);
      const checkoutBody: unknown = await response.json();
      expect(checkoutBody).toEqual({
        url: "https://checkout.stripe.test/session",
      });
      expect(checkoutRequests[0]?.get("line_items[0][price]")).toBe(proPriceId);
      expect(checkoutRequests[0]?.get("line_items[0][quantity]")).toBe("1");
      expect(checkoutRequests[0]?.get("client_reference_id")).toBe(
        organizationId,
      );
      expect(
        checkoutRequests[0]?.get(
          "subscription_data[metadata][organization_id]",
        ),
      ).toBe(organizationId);
      const repeated = await fixture.app.request(
        "/checkout",
        { method: "POST" },
        fixture.bindings,
      );
      const repeatedBody: unknown = await repeated.json();
      expect(repeatedBody).toEqual({
        url: "https://checkout.stripe.test/session",
      });
      expect(checkoutRequests).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("deduplicates concurrent Checkout creation with one claim", async () => {
    const fixture = await createFixture();
    const originalFetch = globalThis.fetch;
    const idempotencyKeys: string[] = [];
    let releaseRequests = () => {};
    const requestsStarted = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    globalThis.fetch = (async (_input, init) => {
      idempotencyKeys.push(
        new Headers(init?.headers).get("Idempotency-Key") ?? "",
      );
      if (idempotencyKeys.length === 2) releaseRequests();
      await requestsStarted;
      const parameters = new URLSearchParams(String(init?.body));
      return Response.json({
        expires_at: Number(parameters.get("expires_at")),
        id: "cs_concurrent_test",
        status: "open",
        url: "https://checkout.stripe.test/concurrent",
      });
    }) as typeof fetch;
    try {
      const responses = await Promise.all([
        fixture.app.request("/checkout", { method: "POST" }, fixture.bindings),
        fixture.app.request("/checkout", { method: "POST" }, fixture.bindings),
      ]);
      expect(responses.map(({ status }) => status)).toEqual([200, 200]);
      expect(new Set(idempotencyKeys).size).toBe(1);
      expect(idempotencyKeys).toHaveLength(2);
      expect(
        fixture.database
          .query(
            `SELECT pending_checkout_session_id FROM organization_billing
             WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({ pending_checkout_session_id: "cs_concurrent_test" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("releases a Checkout claim after a definitive Stripe rejection", async () => {
    const fixture = await createFixture();
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    const idempotencyKeys: string[] = [];
    let requestCount = 0;
    globalThis.fetch = (async (_input, init) => {
      requestCount += 1;
      idempotencyKeys.push(
        new Headers(init?.headers).get("Idempotency-Key") ?? "",
      );
      if (requestCount === 1) {
        return Response.json(
          { error: { message: "Invalid Stripe price" } },
          { status: 400 },
        );
      }
      return Response.json({
        expires_at: Math.floor(Date.now() / 1_000) + 1_800,
        id: "cs_retry_success",
        status: "open",
        url: "https://checkout.stripe.test/retry",
      });
    }) as typeof fetch;
    console.error = () => {};
    try {
      const rejected = await fixture.app.request(
        "/checkout",
        { method: "POST" },
        fixture.bindings,
      );
      expect(rejected.status).toBe(502);
      expect(
        fixture.database
          .query(
            `SELECT checkout_claim_id FROM organization_billing
             WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({ checkout_claim_id: null });
      const retried = await fixture.app.request(
        "/checkout",
        { method: "POST" },
        fixture.bindings,
      );
      expect(retried.status).toBe(200);
      expect(new Set(idempotencyKeys).size).toBe(2);
    } finally {
      console.error = originalConsoleError;
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects malformed successful Stripe responses", async () => {
    const fixture = await createFixture();
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    globalThis.fetch = (async (_input, _init) =>
      Response.json({ id: "not-a-checkout-session" })) as typeof fetch;
    console.error = () => {};
    try {
      const response = await fixture.app.request(
        "/checkout",
        { method: "POST" },
        fixture.bindings,
      );
      expect(response.status).toBe(502);
      expect((await response.json()) as unknown).toEqual({
        error: "Stripe returned a malformed Checkout session ID.",
      });
    } finally {
      console.error = originalConsoleError;
      globalThis.fetch = originalFetch;
    }
  });

  it("invalidates an in-flight Checkout before organization deletion", async () => {
    const fixture = await createFixture();
    const originalFetch = globalThis.fetch;
    let markCheckoutStarted = () => {};
    let releaseCheckout = () => {};
    const checkoutStarted = new Promise<void>((resolve) => {
      markCheckoutStarted = resolve;
    });
    const checkoutReleased = new Promise<void>((resolve) => {
      releaseCheckout = resolve;
    });
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/v1/checkout/sessions")) {
        markCheckoutStarted();
        await checkoutReleased;
        return Response.json({
          expires_at: Math.floor(Date.now() / 1_000) + 1_800,
          id: "cs_in_flight",
          status: "open",
          url: "https://checkout.stripe.test/in-flight",
        });
      }
      if (url.endsWith("/v1/checkout/sessions/cs_in_flight/expire")) {
        return Response.json({ id: "cs_in_flight", status: "expired" });
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    }) as typeof fetch;
    try {
      const checkoutResponse = fixture.app.request(
        "/checkout",
        { method: "POST" },
        fixture.bindings,
      );
      await checkoutStarted;
      expect(
        await cancelOrganizationSubscription(fixture.bindings, organizationId),
      ).toMatchObject({ canceled: false, checkoutGuard: expect.any(String) });
      releaseCheckout();
      expect((await checkoutResponse).status).toBe(409);
      expect(requests).toEqual([
        "https://api.stripe.com/v1/checkout/sessions",
        "https://api.stripe.com/v1/checkout/sessions/cs_in_flight/expire",
      ]);
      expect(
        fixture.database
          .query(
            `SELECT checkout_disabled_at, pending_checkout_session_id
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toMatchObject({
        checkout_disabled_at: expect.any(String),
        pending_checkout_session_id: null,
      });
    } finally {
      releaseCheckout();
      globalThis.fetch = originalFetch;
    }
  });

  it("uses signed, idempotent, ordered webhooks as the entitlement source", async () => {
    const fixture = await createFixture();
    const active = subscriptionEvent("evt_active", 100, "active", 3);
    let currentSubscription = active.data.object;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, _init) =>
      Response.json(currentSubscription)) as typeof fetch;
    try {
      const first = await sendWebhook(fixture, active);
      expect(first.status).toBe(200);
      expect((await first.json()) as unknown).toEqual({ received: true });
      expect((await sendWebhook(fixture, active)).status).toBe(200);
      expect(
        fixture.database
          .query(
            `SELECT stripe_status, seat_quantity, stripe_event_created
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({
        seat_quantity: 3,
        stripe_event_created: 100,
        stripe_status: "active",
      });
      expect(
        fixture.database
          .query("SELECT COUNT(*) AS count FROM stripe_webhook_events")
          .get(),
      ).toEqual({ count: 1 });

      await sendWebhook(
        fixture,
        subscriptionEvent("evt_old", 99, "canceled", 3),
      );
      expect(
        fixture.database
          .query(
            `SELECT stripe_status FROM organization_billing
             WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({ stripe_status: "active" });

      await sendWebhook(
        fixture,
        subscriptionEvent("evt_same_second_stale", 100, "canceled", 3),
      );
      expect(
        fixture.database
          .query(
            `SELECT stripe_status FROM organization_billing
             WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({ stripe_status: "active" });

      const canceled = subscriptionEvent("evt_canceled", 101, "canceled", 3);
      currentSubscription = canceled.data.object;
      await sendWebhook(fixture, canceled);
      const summary = await fixture.app.request(
        "/",
        undefined,
        fixture.bindings,
      );
      expect(await summary.json()).toMatchObject({ plan: "free" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects missing, invalid, and stale webhook signatures", async () => {
    const fixture = await createFixture();
    const event = subscriptionEvent("evt_bad_signature", 100, "active", 1);
    const payload = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1_000);
    const staleTimestamp = timestamp - 301;
    const staleSignature = await webhookSignature(
      fixture.bindings.STRIPE_WEBHOOK_SECRET ?? "",
      staleTimestamp,
      payload,
    );
    const requests = [
      new Request("https://api.test/", { body: payload, method: "POST" }),
      new Request("https://api.test/", {
        body: payload,
        headers: {
          "stripe-signature": `t=${timestamp},v1=${"0".repeat(64)}`,
        },
        method: "POST",
      }),
      new Request("https://api.test/", {
        body: payload,
        headers: {
          "stripe-signature": `t=${staleTimestamp},v1=${staleSignature}`,
        },
        method: "POST",
      }),
    ];
    for (const request of requests) {
      expect(
        (await fixture.webhook.request(request, undefined, fixture.bindings))
          .status,
      ).toBe(400);
    }
    expect(
      fixture.database
        .query("SELECT COUNT(*) AS count FROM stripe_webhook_events")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("only lets verified Checkout replace the current subscription", async () => {
    const fixture = await createFixture();
    const current = subscriptionEvent(
      "evt_current_subscription",
      100,
      "active",
      2,
      "sub_current",
    );
    const checkoutSubscription = subscriptionEvent(
      "unused_checkout_subscription_event",
      101,
      "active",
      3,
      "sub_checkout",
    );
    const checkout = {
      created: 101,
      data: {
        object: {
          client_reference_id: organizationId,
          id: "cs_checkout",
          subscription: "sub_checkout",
        },
      },
      id: "evt_checkout_completed",
      type: "checkout.session.completed",
    };
    const oldSubscription = subscriptionEvent(
      "unused_old_subscription_event",
      102,
      "active",
      1,
      "sub_old",
    );
    const oldCheckout = {
      created: 102,
      data: {
        object: {
          client_reference_id: organizationId,
          id: "cs_old_checkout",
          subscription: "sub_old",
        },
      },
      id: "evt_old_checkout_completed",
      type: "checkout.session.completed",
    };
    let stripeSubscription = current.data.object;
    const requests: Array<{ method: string; url: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const request = { method: init?.method ?? "GET", url: String(input) };
      requests.push(request);
      if (request.method === "DELETE") {
        const canceled = request.url.endsWith("/sub_current")
          ? current.data.object
          : oldSubscription.data.object;
        return Response.json({ ...canceled, status: "canceled" });
      }
      return Response.json(stripeSubscription);
    }) as typeof fetch;
    try {
      expect((await sendWebhook(fixture, current)).status).toBe(200);
      reserveCheckout(fixture.database, "cs_checkout");
      stripeSubscription = checkoutSubscription.data.object;
      expect((await sendWebhook(fixture, checkout)).status).toBe(200);
      stripeSubscription = oldSubscription.data.object;
      expect((await sendWebhook(fixture, oldCheckout)).status).toBe(200);
      expect(
        fixture.database
          .query(
            `SELECT stripe_status, stripe_subscription_id
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({
        stripe_status: "active",
        stripe_subscription_id: "sub_checkout",
      });
      expect(requests).toEqual([
        {
          method: "GET",
          url: "https://api.stripe.com/v1/subscriptions/sub_current",
        },
        {
          method: "GET",
          url: "https://api.stripe.com/v1/subscriptions/sub_checkout",
        },
        {
          method: "DELETE",
          url: "https://api.stripe.com/v1/subscriptions/sub_current",
        },
        {
          method: "GET",
          url: "https://api.stripe.com/v1/subscriptions/sub_old",
        },
        {
          method: "DELETE",
          url: "https://api.stripe.com/v1/subscriptions/sub_old",
        },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("asks Stripe to retry a duplicate webhook still in progress", async () => {
    const fixture = await createFixture();
    const event = subscriptionEvent(
      "evt_duplicate_processing",
      100,
      "active",
      1,
    );
    let markFetchStarted = () => {};
    let releaseFetch = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    const fetchReleased = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, _init) => {
      fetchCount += 1;
      markFetchStarted();
      await fetchReleased;
      return Response.json(event.data.object);
    }) as typeof fetch;
    try {
      const firstResponse = sendWebhook(fixture, event);
      await fetchStarted;
      const duplicateResponse = await sendWebhook(fixture, event);
      expect(duplicateResponse.status).toBe(503);
      expect((await duplicateResponse.json()) as unknown).toEqual({
        error: "Webhook event is already being processed.",
      });
      releaseFetch();
      expect((await firstResponse).status).toBe(200);
      expect((await sendWebhook(fixture, event)).status).toBe(200);
      expect(fetchCount).toBe(1);
    } finally {
      releaseFetch();
      globalThis.fetch = originalFetch;
    }
  });

  it("serializes concurrent same-second subscription refreshes", async () => {
    const fixture = await createFixture();
    const active = subscriptionEvent("evt_concurrent_active", 100, "active", 1);
    const canceled = subscriptionEvent(
      "evt_concurrent_canceled",
      100,
      "canceled",
      1,
    );
    let currentSubscription = active.data.object;
    let releaseFirstFetch = () => {};
    let markFirstFetchStarted = () => {};
    const firstFetchStarted = new Promise<void>((resolve) => {
      markFirstFetchStarted = resolve;
    });
    const firstFetchReleased = new Promise<void>((resolve) => {
      releaseFirstFetch = resolve;
    });
    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, _init) => {
      fetchCount += 1;
      const snapshot = currentSubscription;
      if (fetchCount === 1) {
        markFirstFetchStarted();
        await firstFetchReleased;
      }
      return Response.json(snapshot);
    }) as typeof fetch;
    try {
      const firstResponse = sendWebhook(fixture, active);
      await firstFetchStarted;
      currentSubscription = canceled.data.object;
      const concurrentResponse = await sendWebhook(fixture, canceled);
      expect(concurrentResponse.status).toBe(500);
      releaseFirstFetch();
      expect((await firstResponse).status).toBe(200);
      expect((await sendWebhook(fixture, canceled)).status).toBe(200);
      expect(
        (
          await sendWebhook(
            fixture,
            subscriptionEvent("evt_same_second_retry", 100, "active", 1),
          )
        ).status,
      ).toBe(200);
      expect(
        fixture.database
          .query(
            `SELECT stripe_status FROM organization_billing
             WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({ stripe_status: "canceled" });
    } finally {
      releaseFirstFetch();
      globalThis.fetch = originalFetch;
    }
  });

  it("synchronizes Stripe quantity to active organization members", async () => {
    const fixture = await createFixture();
    addMember(fixture.database, "user-2", organizationId);
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_customer_id, stripe_subscription_id,
          stripe_subscription_item_id, stripe_price_id, stripe_status,
          seat_quantity, stripe_event_created, updated_at)
         VALUES (?, 'cus_test', 'sub_test', 'si_test', ?, 'active', 1, 1, ?)`,
      )
      .run(organizationId, proPriceId, new Date().toISOString());
    const originalFetch = globalThis.fetch;
    const quantities: string[] = [];
    globalThis.fetch = (async (input, init) => {
      expect(String(input)).toContain("/v1/subscription_items/si_test");
      const quantity = new URLSearchParams(String(init?.body)).get("quantity");
      if (quantity) quantities.push(quantity);
      return Response.json({ id: "si_test", quantity: 2 });
    }) as typeof fetch;
    try {
      expect(
        await syncOrganizationSeats(fixture.bindings, organizationId),
      ).toBe(true);
      expect(quantities).toEqual(["2"]);
      expect(
        fixture.database
          .query(
            `SELECT seat_quantity FROM organization_billing
             WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({ seat_quantity: 2 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("serializes concurrent seat changes to the final member count", async () => {
    const fixture = await createFixture();
    addMember(fixture.database, "user-2", organizationId);
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_customer_id, stripe_subscription_id,
          stripe_subscription_item_id, stripe_price_id, stripe_status,
          seat_quantity, stripe_event_created, updated_at)
         VALUES (?, 'cus_test', 'sub_test', 'si_test', ?, 'active', 1, 1, ?)`,
      )
      .run(organizationId, proPriceId, new Date().toISOString());
    let markFirstRequestStarted = () => {};
    let releaseFirstRequest = () => {};
    const firstRequestStarted = new Promise<void>((resolve) => {
      markFirstRequestStarted = resolve;
    });
    const firstRequestReleased = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    const quantities: number[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      const quantity = Number(
        new URLSearchParams(String(init?.body)).get("quantity"),
      );
      quantities.push(quantity);
      if (quantities.length === 1) {
        markFirstRequestStarted();
        await firstRequestReleased;
      }
      return Response.json({ id: "si_test", quantity });
    }) as typeof fetch;
    try {
      const firstSync = syncOrganizationSeats(fixture.bindings, organizationId);
      await firstRequestStarted;
      addMember(fixture.database, "user-3", organizationId);
      const secondSync = syncOrganizationSeats(
        fixture.bindings,
        organizationId,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      releaseFirstRequest();
      expect(await Promise.all([firstSync, secondSync])).toEqual([true, true]);
      expect(quantities).toEqual([2, 3]);
      expect(
        fixture.database
          .query(
            `SELECT seat_quantity FROM organization_billing
             WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({ seat_quantity: 3 });
    } finally {
      releaseFirstRequest();
      globalThis.fetch = originalFetch;
    }
  });

  it("reconciles every subscription when more than one batch is active", async () => {
    const fixture = await createFixture();
    const now = new Date().toISOString();
    for (let index = 0; index < 30; index += 1) {
      const target =
        index < 3 ? `org_user-${index + 1}` : `org_reconcile-${index}`;
      if (index >= 3) {
        const userId = `reconcile-${index}`;
        insertUser(fixture.database, userId);
        fixture.database
          .query(
            `INSERT INTO organization (id, name, slug, createdAt)
             VALUES (?, ?, ?, ?)`,
          )
          .run(target, `Reconcile ${index}`, `reconcile-${index}`, now);
        addMember(fixture.database, userId, target);
      }
      fixture.database
        .query(
          `INSERT INTO organization_billing
           (organization_id, stripe_subscription_item_id, stripe_price_id,
            stripe_status, seat_quantity, stripe_event_created, updated_at)
           VALUES (?, ?, ?, 'active', 1, 1, ?)`,
        )
        .run(target, `si_${index}`, proPriceId, now);
    }

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const id = String(input).split("/").at(-1);
      return Response.json({ id, quantity: 1 });
    }) as typeof fetch;
    try {
      await reconcileSubscriptionSeats(fixture.bindings);
      expect(reconciledCount(fixture.database)).toEqual({ count: 30 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("repairs Stripe seat drift even when the cached quantity matches", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_subscription_item_id, stripe_price_id,
          stripe_status, seat_quantity, stripe_event_created, updated_at)
         VALUES (?, 'si_drift', ?, 'active', 1, 1, ?)`,
      )
      .run(organizationId, proPriceId, new Date().toISOString());
    const originalFetch = globalThis.fetch;
    const requests: Array<{ method: string; quantity: string | null }> = [];
    globalThis.fetch = (async (_input, init) => {
      requests.push({
        method: init?.method ?? "GET",
        quantity: new URLSearchParams(String(init?.body ?? "")).get("quantity"),
      });
      return Response.json({
        id: "si_drift",
        quantity: init?.method === "POST" ? 1 : 2,
      });
    }) as typeof fetch;
    try {
      await reconcileSubscriptionSeats(fixture.bindings);
      expect(requests).toEqual([
        { method: "GET", quantity: null },
        { method: "POST", quantity: "1" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("purges old Free audit history without touching Pro history", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_price_id, stripe_status, seat_quantity,
          stripe_event_created, updated_at)
         VALUES ('org_user-2', ?, 'active', 1, 1, ?)`,
      )
      .run(proPriceId, new Date().toISOString());
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_price_id, stripe_status, seat_quantity,
          stripe_event_created, updated_at)
         VALUES ('org_user-3', 'price_other', 'active', 1, 1, ?)`,
      )
      .run(new Date().toISOString());
    insertAudit(fixture.database, "free-old", organizationId, "2026-06-01");
    insertAudit(fixture.database, "free-recent", organizationId, "2026-08-20");
    insertAudit(fixture.database, "pro-old", "org_user-2", "2026-06-01");
    insertAudit(
      fixture.database,
      "other-price-old",
      "org_user-3",
      "2026-06-01",
    );

    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(2);
    expect(
      fixture.database.query("SELECT id FROM audits ORDER BY id").all(),
    ).toEqual([{ id: "free-recent" }, { id: "pro-old" }]);
  });

  it("drains expired Free audit history across multiple batches", async () => {
    const fixture = await createFixture();
    for (let index = 0; index < 205; index += 1) {
      insertAudit(
        fixture.database,
        `expired-${String(index).padStart(3, "0")}`,
        organizationId,
        "2026-06-01",
      );
    }
    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(205);
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM audits").get(),
    ).toEqual({ count: 0 });
  });

  it("fails closed when retention billing configuration is missing", async () => {
    const fixture = await createFixture();
    insertAudit(fixture.database, "must-retain", organizationId, "2026-06-01");
    const { STRIPE_PRO_PRICE_ID: _priceId, ...missingPriceBindings } =
      fixture.bindings;
    await expect(
      purgeExpiredFreeAuditRuns(missingPriceBindings, "2026-07-27"),
    ).rejects.toThrow(
      "Stripe Pro price configuration is required for retention cleanup.",
    );
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "must-retain" },
    ]);
  });

  it("keeps old audit runs that are still in progress", async () => {
    const fixture = await createFixture();
    insertAudit(fixture.database, "active-old", organizationId, "2026-06-01");
    fixture.database
      .query(
        `UPDATE audits SET status = 'in_progress', completed_at = NULL
         WHERE id = 'active-old'`,
      )
      .run();
    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(0);
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "active-old" },
    ]);
  });
});

async function createFixture(organizationRole = "owner") {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  await applyMigration(database, "0003_create_auth.sql");
  for (const id of ["user-1", "user-2", "user-3"]) insertUser(database, id);
  await applyMigration(database, "0004_create_organizations.sql");
  await applyMigration(database, "0005_create_audits.sql");
  await applyMigration(database, "0011_soft_delete_organizations.sql");
  await applyMigration(database, "0022_version_audit_templates.sql");
  await applyMigration(database, "0032_create_billing.sql");
  const bindings = {
    AUTH_EMAIL_FROM: "security@auth.tearleads.test",
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "https://api.tearleads.test",
    CORS_ORIGIN: "https://app.tearleads.test",
    DB: toD1(database),
    EMAIL: {} as SendEmail,
    IMAGES: {} as ImagesBinding,
    INBOUND_EMAIL_DOMAIN: "inbox.tearleads.test",
    STORAGE: {} as R2Bucket,
    STRIPE_PRO_PRICE_ID: proPriceId,
    STRIPE_SECRET_KEY: "sk_live_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
  } satisfies Bindings;
  const app = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  app.use("*", async (context, next) => {
    context.set("organizationId", organizationId);
    context.set("organizationRole", organizationRole);
    context.set("authSession", {
      user: { email: "user-1@example.com", id: "user-1", role: "user" },
    } as AuthSession);
    await next();
  });
  app.route("/", billing);
  const webhook = new Hono<{ Bindings: Bindings; Variables: AuthVariables }>();
  webhook.post("/", handleStripeWebhook);
  return { app, bindings, database, webhook };
}

function subscriptionEvent(
  id: string,
  created: number,
  status: string,
  quantity: number,
  subscriptionId = "sub_test",
) {
  return {
    created,
    data: {
      object: {
        cancel_at_period_end: false,
        customer: "cus_test",
        id: subscriptionId,
        items: {
          data: [
            {
              current_period_end: 1_800_000_000,
              id:
                subscriptionId === "sub_test"
                  ? "si_test"
                  : `si_${subscriptionId}`,
              price: { id: proPriceId },
              quantity,
            },
          ],
        },
        metadata: { organization_id: organizationId },
        status,
      },
    },
    id,
    type: `customer.subscription.${status === "canceled" ? "deleted" : "updated"}`,
  };
}

async function sendWebhook(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  event: {
    created: number;
    data: { object: unknown };
    id: string;
    type: string;
  },
) {
  const payload = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1_000);
  const signature = await webhookSignature(
    fixture.bindings.STRIPE_WEBHOOK_SECRET ?? "",
    timestamp,
    payload,
  );
  return fixture.webhook.request(
    "/",
    {
      body: payload,
      headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      method: "POST",
    },
    fixture.bindings,
  );
}

async function webhookSignature(
  secret: string,
  timestamp: number,
  payload: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${payload}`),
    ),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function insertUser(database: Database, id: string) {
  database
    .query(
      `INSERT INTO user
       (id, name, email, emailVerified, createdAt, updatedAt, role, banned)
       VALUES (?, ?, ?, 1, ?, ?, 'user', 0)`,
    )
    .run(
      id,
      id,
      `${id}@example.com`,
      new Date().toISOString(),
      new Date().toISOString(),
    );
}

function addMember(database: Database, userId: string, target: string) {
  database
    .query(
      `INSERT INTO member (id, organizationId, userId, role, createdAt)
       VALUES (?, ?, ?, 'member', ?)`,
    )
    .run(crypto.randomUUID(), target, userId, new Date().toISOString());
}

function insertAudit(
  database: Database,
  id: string,
  target: string,
  createdAt: string,
) {
  database
    .query(
      `INSERT INTO audits
       (id, organization_id, template_name, definition, responses, status,
        started_by, created_at, updated_at)
       VALUES (?, ?, 'Example form', '{"version":1,"sections":[]}', '{}',
               'completed', 'user-1', ?, ?)`,
    )
    .run(id, target, createdAt, createdAt);
}

function reserveCheckout(database: Database, sessionId: string) {
  database
    .query(
      `UPDATE organization_billing
       SET pending_checkout_session_id = ?,
           pending_checkout_url = 'https://checkout.stripe.test/pending',
           pending_checkout_expires_at = 2000000000
       WHERE organization_id = ?`,
    )
    .run(sessionId, organizationId);
}

function reconciledCount(database: Database) {
  return database
    .query(
      `SELECT COUNT(*) AS count FROM organization_billing
       WHERE last_reconciled_at IS NOT NULL`,
    )
    .get();
}

interface TestStatement {
  execute: () => unknown;
}

function toD1(database: Database) {
  return {
    batch: async (statements: TestStatement[]) =>
      statements.map((statement) => statement.execute()),
    prepare: (query: string) => {
      let values: SQLQueryBindings[] = [];
      const statement = {
        all: async () => ({ results: database.query(query).all(...values) }),
        bind: (...nextValues: SQLQueryBindings[]) => {
          values = nextValues;
          return statement;
        },
        execute: () => {
          const result = database.query(query).run(...values);
          return { meta: { changes: result.changes } };
        },
        first: async <T>() => database.query(query).get(...values) as T | null,
        run: async () => {
          const result = database.query(query).run(...values);
          return { meta: { changes: result.changes } };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

async function applyMigration(database: Database, filename: string) {
  database.exec(
    await Bun.file(
      new URL(`../migrations/${filename}`, import.meta.url),
    ).text(),
  );
}
