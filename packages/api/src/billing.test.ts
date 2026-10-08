import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { AuthSession } from "./auth";
import type { AuthVariables } from "./authMiddleware";
import {
  billing,
  cancelOrganizationSubscription,
  handleStripeWebhook,
  purgeStripeWebhookReceipts,
  reconcilePendingCheckoutEntitlements,
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

  it("creates and resumes inline Checkout with a publishable key", async () => {
    const fixture = await createFixture();
    const bindings = {
      ...fixture.bindings,
      STRIPE_PUBLISHABLE_KEY: "pk_live_test",
    };
    const originalFetch = globalThis.fetch;
    const requests: Array<{
      body: URLSearchParams;
      method: string;
      url: string;
    }> = [];
    const session = {
      client_reference_id: organizationId,
      client_secret: "cs_inline_test_secret_123",
      expires_at: Math.floor(Date.now() / 1_000) + 1_800,
      id: "cs_inline_test",
      status: "open",
      url: null,
    };
    globalThis.fetch = (async (input, init) => {
      requests.push({
        body: new URLSearchParams(String(init?.body ?? "")),
        method: init?.method ?? "GET",
        url: String(input),
      });
      return Response.json(session);
    }) as typeof fetch;
    try {
      const response = await fixture.app.request(
        "/checkout",
        { method: "POST" },
        bindings,
      );
      expect(response.status).toBe(200);
      const createdBody: unknown = await response.json();
      expect(createdBody).toEqual({
        clientSecret: "cs_inline_test_secret_123",
        publishableKey: "pk_live_test",
      });
      const created = requests[0]?.body;
      expect(created?.get("ui_mode")).toBe("elements");
      expect(created?.get("return_url")).toBe(
        "https://app.tearleads.test/organization/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}",
      );
      expect(created?.get("customer_email")).toBe("user-1@example.com");
      expect(created?.has("success_url")).toBe(false);
      expect(created?.has("cancel_url")).toBe(false);
      expect(
        fixture.database
          .query(
            `SELECT pending_checkout_session_id, pending_checkout_url
             FROM organization_billing`,
          )
          .get(),
      ).toEqual({
        pending_checkout_session_id: "cs_inline_test",
        pending_checkout_url: null,
      });

      const resumed = await fixture.app.request(
        "/checkout",
        { method: "POST" },
        bindings,
      );
      expect(resumed.status).toBe(200);
      const resumedBody: unknown = await resumed.json();
      expect(resumedBody).toEqual({
        clientSecret: "cs_inline_test_secret_123",
        publishableKey: "pk_live_test",
      });
      expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        "POST https://api.stripe.com/v1/checkout/sessions",
        "GET https://api.stripe.com/v1/checkout/sessions/cs_inline_test",
      ]);

      session.status = "complete";
      const finished = await fixture.app.request(
        "/checkout",
        { method: "POST" },
        bindings,
      );
      expect(finished.status).toBe(409);
      expect(requests).toHaveLength(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps hosted Checkout when the publishable key mode differs", async () => {
    const fixture = await createFixture();
    const originalFetch = globalThis.fetch;
    const checkoutRequests: URLSearchParams[] = [];
    globalThis.fetch = (async (_input, init) => {
      checkoutRequests.push(new URLSearchParams(String(init?.body)));
      return Response.json({
        client_reference_id: organizationId,
        expires_at: Math.floor(Date.now() / 1_000) + 1_800,
        id: "cs_hosted_test",
        status: "open",
        url: "https://checkout.stripe.test/hosted",
      });
    }) as typeof fetch;
    try {
      const response = await fixture.app.request(
        "/checkout",
        { method: "POST" },
        { ...fixture.bindings, STRIPE_PUBLISHABLE_KEY: "pk_test_other" },
      );
      const hostedBody: unknown = await response.json();
      expect(hostedBody).toEqual({
        url: "https://checkout.stripe.test/hosted",
      });
      expect(checkoutRequests[0]?.has("ui_mode")).toBe(false);
      expect(checkoutRequests[0]?.has("customer_email")).toBe(false);
      expect(checkoutRequests[0]?.get("success_url")).toContain(
        "checkout=success",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reconciles an expired local Checkout before replacing it", async () => {
    const fixture = await createFixture();
    insertStalePendingCheckout(fixture.database, "cs_completed_at_expiry");
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/v1/checkout/sessions/cs_completed_at_expiry")) {
        return Response.json({
          client_reference_id: organizationId,
          id: "cs_completed_at_expiry",
          status: "complete",
          subscription: "sub_completed_at_expiry",
        });
      }
      if (url.endsWith("/v1/subscriptions/sub_completed_at_expiry")) {
        return Response.json(
          subscriptionEvent(
            "evt_completed_at_expiry",
            100,
            "active",
            1,
            "sub_completed_at_expiry",
          ).data.object,
        );
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    }) as typeof fetch;

    try {
      const response = await fixture.app.request(
        "/checkout",
        { method: "POST" },
        fixture.bindings,
      );
      expect(response.status).toBe(409);
      expect((await response.json()) as unknown).toEqual({
        error: "This organization already has a Pro subscription.",
      });
      expect(requests).toEqual([
        "https://api.stripe.com/v1/checkout/sessions/cs_completed_at_expiry",
        "https://api.stripe.com/v1/subscriptions/sub_completed_at_expiry",
      ]);
      expect(
        fixture.database
          .query(
            `SELECT pending_checkout_session_id, stripe_subscription_id,
                    stripe_status
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({
        pending_checkout_session_id: null,
        stripe_status: "active",
        stripe_subscription_id: "sub_completed_at_expiry",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reclaims a stale deletion lease before creating Checkout", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, checkout_disabled_at,
          checkout_disabled_expires_at, updated_at)
         VALUES (?, 'interrupted-worker', 1, ?)`,
      )
      .run(organizationId, new Date().toISOString());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, _init) =>
      Response.json({
        client_reference_id: organizationId,
        expires_at: Math.floor(Date.now() / 1_000) + 1_800,
        id: "cs_after_interrupted_deletion",
        status: "open",
        url: "https://checkout.stripe.test/recovered",
      })) as typeof fetch;
    try {
      const response = await fixture.app.request(
        "/checkout",
        { method: "POST" },
        fixture.bindings,
      );
      expect(response.status).toBe(200);
      expect(
        fixture.database
          .query(
            `SELECT checkout_disabled_at, checkout_disabled_expires_at
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({
        checkout_disabled_at: null,
        checkout_disabled_expires_at: null,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("allows only the database claimant to create Checkout", async () => {
    const fixture = await createFixture();
    const originalFetch = globalThis.fetch;
    const idempotencyKeys: string[] = [];
    let markRequestStarted = () => {};
    let releaseRequest = () => {};
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve;
    });
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });
    globalThis.fetch = (async (_input, init) => {
      idempotencyKeys.push(
        new Headers(init?.headers).get("Idempotency-Key") ?? "",
      );
      markRequestStarted();
      await requestReleased;
      const parameters = new URLSearchParams(String(init?.body));
      return Response.json({
        expires_at: Number(parameters.get("expires_at")),
        id: "cs_concurrent_test",
        status: "open",
        url: "https://checkout.stripe.test/concurrent",
      });
    }) as typeof fetch;
    try {
      const winner = fixture.app.request(
        "/checkout",
        { method: "POST" },
        fixture.bindings,
      );
      await requestStarted;
      const repeated = fixture.app.request(
        "/checkout",
        { method: "POST" },
        fixture.bindings,
      );
      expect((await repeated).status).toBe(409);
      releaseRequest();
      expect((await winner).status).toBe(200);
      expect(idempotencyKeys).toHaveLength(1);
      expect(
        fixture.database
          .query(
            `SELECT pending_checkout_session_id FROM organization_billing
             WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({ pending_checkout_session_id: "cs_concurrent_test" });
    } finally {
      releaseRequest();
      globalThis.fetch = originalFetch;
    }
  });

  it("reconciles an indeterminate Checkout through its webhook", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_customer_id, updated_at)
         VALUES (?, 'cus_original', ?)`,
      )
      .run(organizationId, new Date().toISOString());
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    const customers: Array<string | null> = [];
    const idempotencyKeys: string[] = [];
    const checkoutClaimIds: Array<string | null> = [];
    const subscriptionClaimIds: Array<string | null> = [];
    let requestCount = 0;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/checkout/sessions")) {
        requestCount += 1;
        idempotencyKeys.push(
          new Headers(init?.headers).get("Idempotency-Key") ?? "",
        );
        const parameters = new URLSearchParams(String(init?.body));
        customers.push(parameters.get("customer"));
        checkoutClaimIds.push(parameters.get("metadata[checkout_claim_id]"));
        subscriptionClaimIds.push(
          parameters.get("subscription_data[metadata][checkout_claim_id]"),
        );
        return Response.json(
          { error: { message: "Stripe temporarily unavailable" } },
          { status: 500 },
        );
      }
      if (url.endsWith("/v1/subscriptions/sub_indeterminate")) {
        return Response.json(
          subscriptionEvent(
            "unused_indeterminate",
            101,
            "active",
            1,
            "sub_indeterminate",
          ).data.object,
        );
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    }) as typeof fetch;
    console.error = () => {};
    try {
      const failed = await fixture.app.request(
        "/checkout",
        { method: "POST" },
        fixture.bindings,
      );
      expect(failed.status).toBe(502);
      const claim = fixture.database
        .query(
          `SELECT checkout_claim_id, checkout_claim_price_id
           FROM organization_billing WHERE organization_id = ?`,
        )
        .get(organizationId) as {
        checkout_claim_id: string;
        checkout_claim_price_id: string;
      };
      const claimId = claim.checkout_claim_id;
      expect(typeof claimId).toBe("string");
      expect(claim.checkout_claim_price_id).toBe(proPriceId);
      expect(checkoutClaimIds).toEqual([claimId]);
      expect(subscriptionClaimIds).toEqual([claimId]);

      const retried = await fixture.app.request(
        "/checkout",
        { method: "POST" },
        fixture.bindings,
      );
      expect(retried.status).toBe(409);
      expect(requestCount).toBe(1);

      const subscriptionCreated = subscriptionEvent(
        "evt_indeterminate_subscription",
        100,
        "active",
        1,
        "sub_indeterminate",
      );
      expect((await sendWebhook(fixture, subscriptionCreated)).status).toBe(
        200,
      );
      expect(
        fixture.database
          .query(
            `SELECT checkout_claim_id, stripe_subscription_id
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({
        checkout_claim_id: claimId,
        stripe_subscription_id: "sub_indeterminate",
      });

      const completed = {
        created: 101,
        data: {
          object: {
            client_reference_id: organizationId,
            id: "cs_indeterminate",
            metadata: {
              checkout_claim_id: claimId,
              organization_id: organizationId,
            },
            subscription: "sub_indeterminate",
          },
        },
        id: "evt_indeterminate_checkout",
        type: "checkout.session.completed",
      };
      console.error = originalConsoleError;
      expect((await sendWebhook(fixture, completed)).status).toBe(200);
      expect(
        fixture.database
          .query(
            `SELECT checkout_claim_id, pending_checkout_session_id,
                    stripe_status, stripe_subscription_id
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({
        checkout_claim_id: null,
        pending_checkout_session_id: null,
        stripe_status: "active",
        stripe_subscription_id: "sub_indeterminate",
      });
      expect(idempotencyKeys).toHaveLength(1);
      expect(customers).toEqual(["cus_original"]);
    } finally {
      console.error = originalConsoleError;
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
    let responseBody: Record<string, unknown> = {
      id: "not-a-checkout-session",
    };
    globalThis.fetch = (async (_input, _init) =>
      Response.json(responseBody)) as typeof fetch;
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

      responseBody = {
        expires_at: Math.floor(Date.now() / 1_000) + 1_800,
        id: "cs_missing_url",
        status: "open",
      };
      const missingUrlFixture = await createFixture();
      const missingUrl = await missingUrlFixture.app.request(
        "/checkout",
        { method: "POST" },
        missingUrlFixture.bindings,
      );
      expect(missingUrl.status).toBe(502);
      expect((await missingUrl.json()) as unknown).toEqual({
        error: "Stripe did not return a checkout URL.",
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

  it("skips terminal subscriptions during organization deletion", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_subscription_id, stripe_status, updated_at)
         VALUES (?, 'sub_incomplete_expired', 'incomplete_expired', ?)`,
      )
      .run(organizationId, new Date().toISOString());
    const originalFetch = globalThis.fetch;
    let requestedStripe = false;
    globalThis.fetch = (async (_input): Promise<Response> => {
      requestedStripe = true;
      throw new Error("Terminal subscriptions must not reach Stripe.");
    }) as typeof fetch;
    try {
      expect(
        await cancelOrganizationSubscription(fixture.bindings, organizationId),
      ).toMatchObject({ canceled: false, checkoutGuard: expect.any(String) });
      expect(requestedStripe).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when Stripe cannot find a subscription to cancel", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_subscription_id,
          stripe_subscription_item_id, stripe_price_id, stripe_status,
          updated_at)
         VALUES (?, 'sub_wrong_account', 'si_wrong_account', ?, 'active', ?)`,
      )
      .run(organizationId, proPriceId, new Date().toISOString());
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, _init) =>
      Response.json(
        { error: { message: "No such subscription" } },
        { status: 404 },
      )) as typeof fetch;
    try {
      await expect(
        cancelOrganizationSubscription(fixture.bindings, organizationId),
      ).rejects.toThrow("No such subscription");
      expect(
        fixture.database
          .query(
            `SELECT checkout_disabled_at, stripe_status
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({ checkout_disabled_at: null, stripe_status: "active" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reclaims a stale deletion lease after an interrupted worker", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, checkout_disabled_at,
          checkout_disabled_expires_at, updated_at)
         VALUES (?, 'interrupted-worker', 1, ?)`,
      )
      .run(organizationId, new Date().toISOString());

    const result = await cancelOrganizationSubscription(
      fixture.bindings,
      organizationId,
    );
    expect(result).toMatchObject({
      canceled: false,
      checkoutGuard: expect.any(String),
    });
    expect(result.checkoutGuard).not.toBe("interrupted-worker");
    expect(
      fixture.database
        .query(
          `SELECT checkout_disabled_at, checkout_disabled_expires_at
           FROM organization_billing WHERE organization_id = ?`,
        )
        .get(organizationId),
    ).toEqual({
      checkout_disabled_at: result.checkoutGuard,
      checkout_disabled_expires_at: expect.any(Number),
    });
  });

  it("keeps concurrent organization deletions request-owned", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_subscription_id,
          stripe_subscription_item_id, stripe_price_id, stripe_status,
          updated_at)
         VALUES (?, 'sub_delete_race', 'si_sub_delete_race', ?, 'active', ?)`,
      )
      .run(organizationId, proPriceId, new Date().toISOString());
    let markCancellationStarted = () => {};
    let releaseCancellation = () => {};
    const cancellationStarted = new Promise<void>((resolve) => {
      markCancellationStarted = resolve;
    });
    const cancellationReleased = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    let requestCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input) => {
      requestCount += 1;
      markCancellationStarted();
      await cancellationReleased;
      return Response.json(
        subscriptionEvent(
          "unused_delete_race",
          100,
          "canceled",
          1,
          "sub_delete_race",
        ).data.object,
      );
    }) as typeof fetch;
    try {
      const winner = cancelOrganizationSubscription(
        fixture.bindings,
        organizationId,
      );
      await cancellationStarted;
      await expect(
        cancelOrganizationSubscription(fixture.bindings, organizationId),
      ).rejects.toThrow("Organization deletion is already in progress.");
      releaseCancellation();
      const result = await winner;
      expect(requestCount).toBe(1);
      expect(
        fixture.database
          .query(
            `SELECT checkout_disabled_at FROM organization_billing
             WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({ checkout_disabled_at: result.checkoutGuard });
    } finally {
      releaseCancellation();
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

  it("prunes Stripe webhook receipts outside the replay window", async () => {
    const fixture = await createFixture();
    fixture.database.exec(
      `INSERT INTO stripe_webhook_events
       (id, event_type, stripe_created, received_at, processed_at)
       VALUES
         ('evt_old_processed', 'invoice.paid', 1,
          '2026-06-01', '2026-06-01'),
         ('evt_old_unprocessed', 'invoice.paid', 2,
          '2026-06-01', NULL),
         ('evt_recent', 'invoice.paid', 3,
          '2026-08-20', '2026-08-20')`,
    );

    expect(
      await purgeStripeWebhookReceipts(fixture.bindings, "2026-07-01"),
    ).toBe(2);
    expect(
      fixture.database.query("SELECT id FROM stripe_webhook_events").all(),
    ).toEqual([{ id: "evt_recent" }]);
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

  it("stops reading oversized webhook payloads", async () => {
    const fixture = await createFixture();
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        canceled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array(256 * 1024 + 1));
      },
    });
    const response = await fixture.webhook.request(
      new Request("https://api.test/", { body, method: "POST" }),
      undefined,
      fixture.bindings,
    );

    expect(response.status).toBe(413);
    expect(canceled).toBe(true);
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
            `SELECT paid_ended_at, stripe_status, stripe_subscription_id
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({
        paid_ended_at: null,
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

  it("waits for a Checkout webhook before confirming its subscription", async () => {
    const fixture = await createFixture();
    insertStalePendingCheckout(fixture.database, "cs_sync_race");
    const subscription = subscriptionEvent(
      "unused_sync_race",
      101,
      "active",
      1,
      "sub_sync_race",
    ).data.object;
    const checkout = {
      created: 101,
      data: {
        object: {
          client_reference_id: organizationId,
          id: "cs_sync_race",
          subscription: "sub_sync_race",
        },
      },
      id: "evt_sync_race",
      type: "checkout.session.completed",
    };
    let markSubscriptionFetchStarted = () => {};
    let markCheckoutFetched = () => {};
    let releaseSubscriptionFetch = () => {};
    const subscriptionFetchStarted = new Promise<void>((resolve) => {
      markSubscriptionFetchStarted = resolve;
    });
    const checkoutFetched = new Promise<void>((resolve) => {
      markCheckoutFetched = resolve;
    });
    const subscriptionFetchReleased = new Promise<void>((resolve) => {
      releaseSubscriptionFetch = resolve;
    });
    let subscriptionFetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/v1/checkout/sessions/cs_sync_race")) {
        markCheckoutFetched();
        return Response.json({
          client_reference_id: organizationId,
          id: "cs_sync_race",
          status: "complete",
          subscription: "sub_sync_race",
        });
      }
      if (url.pathname.endsWith("/v1/subscriptions/sub_sync_race")) {
        subscriptionFetchCount += 1;
        markSubscriptionFetchStarted();
        await subscriptionFetchReleased;
        return Response.json(subscription);
      }
      throw new Error(`Unexpected Stripe request: ${url.href}`);
    }) as typeof fetch;
    try {
      const webhookResponse = sendWebhook(fixture, checkout);
      await subscriptionFetchStarted;
      const confirmationResponse = fixture.app.request(
        "/?session_id=cs_sync_race",
        undefined,
        fixture.bindings,
      );
      await checkoutFetched;
      releaseSubscriptionFetch();
      expect((await webhookResponse).status).toBe(200);
      expect((await confirmationResponse).status).toBe(200);
      expect(subscriptionFetchCount).toBe(1);
    } finally {
      releaseSubscriptionFetch();
      globalThis.fetch = originalFetch;
    }
  });

  it("keeps the current subscription for an invalid Checkout price", async () => {
    const fixture = await createFixture();
    const current = subscriptionEvent(
      "evt_price_current",
      100,
      "active",
      2,
      "sub_price_current",
    );
    const invalid = subscriptionEvent(
      "unused_price_invalid",
      101,
      "active",
      2,
      "sub_price_invalid",
      "price_other",
    );
    const checkout = {
      created: 101,
      data: {
        object: {
          client_reference_id: organizationId,
          id: "cs_price_invalid",
          subscription: "sub_price_invalid",
        },
      },
      id: "evt_price_checkout",
      type: "checkout.session.completed",
    };
    let stripeSubscription = current.data.object;
    const requests: Array<{ method: string; url: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      const request = { method: init?.method ?? "GET", url: String(input) };
      requests.push(request);
      if (request.method === "DELETE") {
        return Response.json({ ...invalid.data.object, status: "canceled" });
      }
      return Response.json(stripeSubscription);
    }) as typeof fetch;
    try {
      expect((await sendWebhook(fixture, current)).status).toBe(200);
      reserveCheckout(fixture.database, "cs_price_invalid");
      stripeSubscription = invalid.data.object;
      expect((await sendWebhook(fixture, checkout)).status).toBe(200);
      expect(
        fixture.database
          .query(
            `SELECT pending_checkout_session_id, stripe_subscription_id
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({
        pending_checkout_session_id: null,
        stripe_subscription_id: "sub_price_current",
      });
      expect(requests).toEqual([
        {
          method: "GET",
          url: "https://api.stripe.com/v1/subscriptions/sub_price_current",
        },
        {
          method: "GET",
          url: "https://api.stripe.com/v1/subscriptions/sub_price_invalid",
        },
        {
          method: "DELETE",
          url: "https://api.stripe.com/v1/subscriptions/sub_price_invalid",
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

  it("rotates a bounded batch of subscription reconciliations", async () => {
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
      expect(reconciledCount(fixture.database)).toEqual({ count: 25 });
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

  it("rotates failed stale Checkout reconciliations beyond the batch", async () => {
    const fixture = await createFixture();
    const sessions = new Map<string, string>();
    const insertOrganization = fixture.database.query(
      `INSERT INTO organization (id, name, slug, createdAt)
       VALUES (?, 'Pending Checkout', ?, ?)`,
    );
    const insertBilling = fixture.database.query(
      `INSERT INTO organization_billing
       (organization_id, pending_checkout_session_id, pending_checkout_url,
        pending_checkout_expires_at, updated_at)
       VALUES (?, ?, 'https://checkout.stripe.test/stale', 1, ?)`,
    );
    for (let index = 0; index < 26; index += 1) {
      const suffix = index === 25 ? "z" : index.toString().padStart(2, "0");
      const target = `org_pending_${suffix}`;
      const sessionId = `cs_pending_${suffix}`;
      const now = new Date().toISOString();
      insertOrganization.run(target, `pending-${suffix}`, now);
      insertBilling.run(target, sessionId, now);
      sessions.set(sessionId, target);
    }
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const sessionId = String(input).split("/").at(-1) ?? "";
      requests.push(sessionId);
      const target = sessions.get(sessionId);
      if (!target) throw new Error(`Unexpected Checkout session: ${sessionId}`);
      if (sessionId !== "cs_pending_z") {
        return Response.json(
          { error: { message: "Stripe is unavailable" } },
          { status: 500 },
        );
      }
      return Response.json({
        client_reference_id: target,
        id: sessionId,
        status: "expired",
        subscription: null,
      });
    }) as typeof fetch;
    console.error = () => {};

    try {
      await reconcilePendingCheckoutEntitlements(fixture.bindings, 100);
      expect(requests).toHaveLength(25);
      expect(requests).not.toContain("cs_pending_z");
      expect(
        fixture.database
          .query(
            `SELECT COUNT(*) AS count FROM organization_billing
             WHERE pending_checkout_retry_at = 400`,
          )
          .get(),
      ).toEqual({ count: 25 });

      await reconcilePendingCheckoutEntitlements(fixture.bindings, 100);
      expect(requests.at(-1)).toBe("cs_pending_z");
      expect(
        fixture.database
          .query(
            `SELECT pending_checkout_session_id
             FROM organization_billing WHERE organization_id = 'org_pending_z'`,
          )
          .get(),
      ).toEqual({ pending_checkout_session_id: null });
    } finally {
      console.error = originalConsoleError;
      globalThis.fetch = originalFetch;
    }
  });

  it("purges old Free audit history without touching Pro history", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_subscription_id,
          stripe_subscription_item_id, stripe_price_id, stripe_status,
          seat_quantity, stripe_event_created, updated_at)
         VALUES ('org_user-2', 'sub_retention_pro', 'si_retention_pro', ?,
                 'active', 1, 1, ?)`,
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
    ).toBe(1);
    expect(
      fixture.database.query("SELECT id FROM audits ORDER BY id").all(),
    ).toEqual([
      { id: "free-recent" },
      { id: "other-price-old" },
      { id: "pro-old" },
    ]);
  });

  it("retains Pro history when a paid row is missing its subscription id", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_price_id, stripe_status, seat_quantity,
          stripe_event_created, updated_at)
         VALUES (?, ?, 'active', 1, 1, ?)`,
      )
      .run(organizationId, proPriceId, new Date().toISOString());
    insertAudit(
      fixture.database,
      "partial-pro-row-old",
      organizationId,
      "2026-06-01",
    );

    const summary = await fixture.app.request("/", undefined, fixture.bindings);
    expect(await summary.json()).toMatchObject({ plan: "pro" });
    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(0);
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "partial-pro-row-old" },
    ]);
  });

  it("retains history for an unresolved active Stripe price", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_subscription_id,
          stripe_subscription_item_id, stripe_price_id, stripe_status,
          seat_quantity, stripe_event_created, updated_at)
         VALUES (?, 'sub_unknown_price', 'si_unknown_price',
                 'price_unknown', 'active', 1, 1, ?)`,
      )
      .run(organizationId, new Date().toISOString());
    insertAudit(
      fixture.database,
      "unknown-price-old",
      organizationId,
      "2026-06-01",
    );

    const summary = await fixture.app.request("/", undefined, fixture.bindings);
    expect(await summary.json()).toMatchObject({ plan: "free" });
    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(0);
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "unknown-price-old" },
    ]);
  });

  it("keeps Pro history after the configured price rotates", async () => {
    const fixture = await createFixture();
    let subscription = subscriptionEvent(
      "evt_before_price_rotation",
      100,
      "active",
      1,
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input) =>
      Response.json(subscription.data.object)) as typeof fetch;
    try {
      expect((await sendWebhook(fixture, subscription)).status).toBe(200);
      fixture.bindings.STRIPE_PRO_LEGACY_PRICE_IDS = proPriceId;
      fixture.bindings.STRIPE_PRO_PRICE_ID = "price_rotated";
      subscription = subscriptionEvent(
        "evt_after_price_rotation",
        101,
        "active",
        1,
      );
      expect((await sendWebhook(fixture, subscription)).status).toBe(200);
      insertAudit(
        fixture.database,
        "rotated-price-pro-old",
        organizationId,
        "2026-06-01",
      );

      expect(
        await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
      ).toBe(0);
      expect(
        fixture.database
          .query(
            `SELECT stripe_price_id, stripe_subscription_item_id
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({
        stripe_price_id: proPriceId,
        stripe_subscription_item_id: "si_test",
      });
      expect(
        await (
          await fixture.app.request("/", undefined, fixture.bindings)
        ).json(),
      ).toMatchObject({ plan: "pro" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("clears a Pro item after its price leaves the allowlist", async () => {
    const fixture = await createFixture();
    let subscription = subscriptionEvent("evt_allowed_price", 100, "active", 1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input) =>
      Response.json(subscription.data.object)) as typeof fetch;
    try {
      expect((await sendWebhook(fixture, subscription)).status).toBe(200);
      subscription = subscriptionEvent(
        "evt_removed_price",
        101,
        "active",
        1,
        "sub_test",
        "price_removed",
      );
      expect((await sendWebhook(fixture, subscription)).status).toBe(200);
      expect(
        fixture.database
          .query(
            `SELECT stripe_price_id, stripe_subscription_item_id
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({
        stripe_price_id: null,
        stripe_subscription_item_id: null,
      });
      expect(
        await (
          await fixture.app.request("/", undefined, fixture.bindings)
        ).json(),
      ).toMatchObject({ plan: "free" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("caps expired Free audit cleanup per invocation", async () => {
    const fixture = await createFixture();
    for (let index = 0; index < 605; index += 1) {
      insertAudit(
        fixture.database,
        `expired-${String(index).padStart(3, "0")}`,
        organizationId,
        "2026-06-01",
      );
    }
    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(500);
    expect(
      fixture.database.query("SELECT COUNT(*) AS count FROM audits").get(),
    ).toEqual({ count: 105 });
    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(105);
  });

  it("keeps history while Checkout entitlement is unresolved", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, pending_checkout_session_id,
          pending_checkout_url, pending_checkout_expires_at, updated_at)
         VALUES (?, 'cs_retention_race',
                 'https://checkout.stripe.test/retention-race', 2000000000, ?)`,
      )
      .run(organizationId, new Date().toISOString());
    insertAudit(
      fixture.database,
      "pending-checkout-old",
      organizationId,
      "2026-06-01",
    );

    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(0);
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "pending-checkout-old" },
    ]);
  });

  it("keeps history while Checkout creation is in flight", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, checkout_claim_id, checkout_claim_quantity,
          checkout_claim_expires_at, updated_at)
         VALUES (?, 'claim_retention_race', 1, 2000000000, ?)`,
      )
      .run(organizationId, new Date().toISOString());
    insertAudit(
      fixture.database,
      "checkout-claim-old",
      organizationId,
      "2026-06-01",
    );

    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(0);
    fixture.database
      .query(
        `UPDATE organization_billing SET checkout_claim_expires_at = 1
         WHERE organization_id = ?`,
      )
      .run(organizationId);
    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(1);
  });

  it("keeps lapsed paid history until the grace period ends", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_subscription_id, stripe_status,
          paid_ended_at, updated_at)
         VALUES (?, 'sub_lapsed', 'canceled', '2026-08-01T00:00:00.000Z', ?)`,
      )
      .run(organizationId, new Date().toISOString());
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_subscription_id, stripe_status, updated_at)
         VALUES ('org_user-2', 'sub_never_paid', 'incomplete_expired', ?)`,
      )
      .run(new Date().toISOString());
    insertAudit(fixture.database, "lapsed-old", organizationId, "2026-06-01");
    insertAudit(fixture.database, "never-paid-old", "org_user-2", "2026-06-01");
    insertAudit(fixture.database, "no-billing-old", "org_user-3", "2026-06-01");

    expect(
      await purgeExpiredFreeAuditRuns(
        fixture.bindings,
        "2026-07-27",
        "2026-08-01T00:00:00.000Z",
      ),
    ).toBe(2);
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "lapsed-old" },
    ]);
    expect(
      await purgeExpiredFreeAuditRuns(
        fixture.bindings,
        "2026-07-27",
        "2026-08-01T00:00:01.000Z",
      ),
    ).toBe(1);
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([]);
  });

  it("starts the grace period when a paid subscription lapses", async () => {
    const fixture = await createFixture();
    let subscription = subscriptionEvent("evt_paid", 100, "active", 1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input) =>
      Response.json(subscription.data.object)) as typeof fetch;
    const paidEndedAt = () =>
      (
        fixture.database
          .query(
            `SELECT paid_ended_at FROM organization_billing
             WHERE organization_id = ?`,
          )
          .get(organizationId) as { paid_ended_at: string | null }
      ).paid_ended_at;
    try {
      expect((await sendWebhook(fixture, subscription)).status).toBe(200);
      expect(paidEndedAt()).toBeNull();

      const beforeLapse = new Date().toISOString();
      subscription = subscriptionEvent("evt_lapsed", 101, "canceled", 1);
      expect((await sendWebhook(fixture, subscription)).status).toBe(200);
      const lapsedAt = paidEndedAt();
      expect(lapsedAt).not.toBeNull();
      expect(String(lapsedAt) >= beforeLapse).toBe(true);
      insertAudit(fixture.database, "lapsed-old", organizationId, "2026-06-01");
      expect(await purgeExpiredFreeAuditRuns(fixture.bindings)).toBe(0);

      // A stale event refetches Stripe's current state, so it neither clears
      // the marker nor moves the grace period forward.
      const staleUpdate = subscriptionEvent("evt_stale", 99, "active", 1);
      expect((await sendWebhook(fixture, staleUpdate)).status).toBe(200);
      await Bun.sleep(2);
      subscription = subscriptionEvent("evt_lapsed_again", 102, "canceled", 1);
      expect((await sendWebhook(fixture, subscription)).status).toBe(200);
      expect(paidEndedAt()).toBe(lapsedAt);

      subscription = subscriptionEvent("evt_resubscribed", 103, "active", 1);
      expect((await sendWebhook(fixture, subscription)).status).toBe(200);
      expect(paidEndedAt()).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ends the grace period when Checkout starts a new subscription", async () => {
    const fixture = await createFixture();
    let subscription = subscriptionEvent(
      "evt_before_lapse",
      100,
      "active",
      1,
      "sub_lapsed",
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input) =>
      Response.json(subscription.data.object)) as typeof fetch;
    const billingRow = () =>
      fixture.database
        .query(
          `SELECT paid_ended_at IS NOT NULL AS in_grace, stripe_status,
                  stripe_subscription_id
           FROM organization_billing WHERE organization_id = ?`,
        )
        .get(organizationId);
    try {
      expect((await sendWebhook(fixture, subscription)).status).toBe(200);
      subscription = subscriptionEvent(
        "evt_lapse",
        101,
        "canceled",
        1,
        "sub_lapsed",
      );
      expect((await sendWebhook(fixture, subscription)).status).toBe(200);
      expect(billingRow()).toEqual({
        in_grace: 1,
        stripe_status: "canceled",
        stripe_subscription_id: "sub_lapsed",
      });

      reserveCheckout(fixture.database, "cs_resubscribe");
      subscription = subscriptionEvent(
        "unused_resubscribe",
        102,
        "active",
        1,
        "sub_resubscribed",
      );
      const checkout = {
        created: 102,
        data: {
          object: {
            client_reference_id: organizationId,
            id: "cs_resubscribe",
            subscription: "sub_resubscribed",
          },
        },
        id: "evt_resubscribe_checkout",
        type: "checkout.session.completed",
      };
      expect((await sendWebhook(fixture, checkout)).status).toBe(200);
      expect(billingRow()).toEqual({
        in_grace: 0,
        stripe_status: "active",
        stripe_subscription_id: "sub_resubscribed",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("ignores a replaced subscription's lapse for the grace period", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_customer_id, stripe_subscription_id,
          stripe_subscription_item_id, stripe_price_id, stripe_status,
          stripe_event_created, updated_at)
         VALUES (?, 'cus_test', 'sub_current', 'si_sub_current', ?, 'active',
                 100, ?)`,
      )
      .run(organizationId, proPriceId, new Date().toISOString());
    const replaced = subscriptionEvent(
      "evt_replaced_lapse",
      101,
      "canceled",
      1,
      "sub_replaced",
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input) =>
      Response.json(replaced.data.object)) as typeof fetch;
    try {
      expect((await sendWebhook(fixture, replaced)).status).toBe(200);
      expect(
        fixture.database
          .query(
            `SELECT stripe_subscription_id, stripe_status, paid_ended_at
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({
        paid_ended_at: null,
        stripe_status: "active",
        stripe_subscription_id: "sub_current",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("backfills a grace period for organizations that already lapsed", async () => {
    const database = new Database(":memory:");
    await applyMigration(database, "0003_create_auth.sql");
    for (const id of ["user-1", "user-2", "user-3"]) insertUser(database, id);
    await applyMigration(database, "0004_create_organizations.sql");
    await applyMigration(database, "0011_soft_delete_organizations.sql");
    await applyMigration(database, "0032_create_billing.sql");
    const now = new Date().toISOString();
    database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_subscription_id, stripe_status, updated_at)
         VALUES ('org_user-1', 'sub_canceled', 'canceled', ?),
                ('org_user-2', 'sub_active', 'active', ?)`,
      )
      .run(now, now);
    database
      .query(
        `INSERT INTO organization_billing (organization_id, updated_at)
         VALUES ('org_user-3', ?)`,
      )
      .run(now);
    await applyMigration(database, "0053_track_paid_billing_end.sql");

    const rows = database
      .query(
        `SELECT organization_id, paid_ended_at FROM organization_billing
         ORDER BY organization_id`,
      )
      .all() as { organization_id: string; paid_ended_at: string | null }[];
    expect(rows.map((row) => row.paid_ended_at !== null)).toEqual([
      true,
      false,
      false,
    ]);
    expect(String(rows[0]?.paid_ended_at) >= now).toBe(true);
  });

  it("keeps history while organization deletion is in flight", async () => {
    const fixture = await createFixture();
    fixture.database
      .query(
        `INSERT INTO organization_billing
         (organization_id, stripe_status, checkout_disabled_at,
          checkout_disabled_expires_at, updated_at)
         VALUES (?, 'canceled', 'deletion-in-flight', 2000000000, ?)`,
      )
      .run(organizationId, new Date().toISOString());
    insertAudit(
      fixture.database,
      "deletion-in-flight-old",
      organizationId,
      "2026-06-01",
    );

    expect(
      await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
    ).toBe(0);
    expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
      { id: "deletion-in-flight-old" },
    ]);
  });

  it("reconciles a completed stale Checkout before retention", async () => {
    const fixture = await createFixture();
    insertStalePendingCheckout(fixture.database, "cs_retention_complete");
    insertAudit(
      fixture.database,
      "completed-checkout-old",
      organizationId,
      "2026-06-01",
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.endsWith("/v1/checkout/sessions/cs_retention_complete")) {
        return Response.json({
          client_reference_id: organizationId,
          id: "cs_retention_complete",
          status: "complete",
          subscription: "sub_retention_complete",
        });
      }
      if (url.endsWith("/v1/subscriptions/sub_retention_complete")) {
        return Response.json(
          subscriptionEvent(
            "evt_retention_complete",
            100,
            "active",
            1,
            "sub_retention_complete",
          ).data.object,
        );
      }
      throw new Error(`Unexpected Stripe request: ${url}`);
    }) as typeof fetch;
    try {
      expect(
        await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
      ).toBe(0);
      expect(
        fixture.database
          .query(
            `SELECT pending_checkout_session_id, stripe_price_id,
                    stripe_status
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({
        pending_checkout_session_id: null,
        stripe_price_id: proPriceId,
        stripe_status: "active",
      });
      expect(fixture.database.query("SELECT id FROM audits").all()).toEqual([
        { id: "completed-checkout-old" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("clears an expired stale Checkout before retention", async () => {
    const fixture = await createFixture();
    insertStalePendingCheckout(fixture.database, "cs_retention_expired");
    insertAudit(
      fixture.database,
      "expired-checkout-old",
      organizationId,
      "2026-06-01",
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input) =>
      Response.json({
        client_reference_id: organizationId,
        id: "cs_retention_expired",
        status: "expired",
        subscription: null,
      })) as typeof fetch;
    try {
      expect(
        await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
      ).toBe(1);
      expect(
        fixture.database
          .query(
            `SELECT pending_checkout_session_id
             FROM organization_billing WHERE organization_id = ?`,
          )
          .get(organizationId),
      ).toEqual({ pending_checkout_session_id: null });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("expires an abandoned stale Checkout before retention", async () => {
    const fixture = await createFixture();
    insertStalePendingCheckout(fixture.database, "cs_retention_abandoned");
    insertAudit(
      fixture.database,
      "abandoned-checkout-old",
      organizationId,
      "2026-06-01",
    );
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      return Response.json({
        client_reference_id: organizationId,
        expires_at: 1,
        id: "cs_retention_abandoned",
        status: requests.length === 1 ? "open" : "expired",
        subscription: null,
      });
    }) as typeof fetch;
    try {
      expect(
        await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
      ).toBe(1);
      expect(requests).toEqual([
        "https://api.stripe.com/v1/checkout/sessions/cs_retention_abandoned",
        "https://api.stripe.com/v1/checkout/sessions/cs_retention_abandoned/expire",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("isolates failed Checkout reconciliation during retention", async () => {
    const fixture = await createFixture();
    insertStalePendingCheckout(fixture.database, "cs_retention_failed");
    insertAudit(
      fixture.database,
      "failed-checkout-old",
      organizationId,
      "2026-06-01",
    );
    insertAudit(fixture.database, "other-free-old", "org_user-2", "2026-06-01");
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    globalThis.fetch = (async (_input) =>
      Response.json(
        { error: { message: "Stripe is unavailable" } },
        { status: 500 },
      )) as typeof fetch;
    console.error = () => {};
    try {
      expect(
        await purgeExpiredFreeAuditRuns(fixture.bindings, "2026-07-27"),
      ).toBe(1);
      expect(
        fixture.database.query("SELECT id FROM audits ORDER BY id").all(),
      ).toEqual([{ id: "failed-checkout-old" }]);
    } finally {
      console.error = originalConsoleError;
      globalThis.fetch = originalFetch;
    }
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
  await applyMigration(database, "0053_track_paid_billing_end.sql");
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
    STRIPE_PRO_LEGACY_PRICE_IDS: "",
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
  priceId = proPriceId,
) {
  return {
    created,
    data: {
      object: {
        cancel_at: null,
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
              price: { id: priceId },
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

function insertStalePendingCheckout(database: Database, sessionId: string) {
  database
    .query(
      `INSERT INTO organization_billing
       (organization_id, pending_checkout_session_id, pending_checkout_url,
        pending_checkout_expires_at, updated_at)
       VALUES (?, ?, 'https://checkout.stripe.test/stale', 1, ?)`,
    )
    .run(organizationId, sessionId, new Date().toISOString());
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
