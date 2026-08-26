import type { Bindings } from "./types";

const stripeApiVersion = "2026-06-24.dahlia";
const webhookToleranceSeconds = 5 * 60;

export class StripeConfigurationError extends Error {}

export class StripeApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function stripeGet(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  path: string,
  query?: URLSearchParams,
) {
  const suffix = query && query.size > 0 ? `?${query}` : "";
  return stripeRequest(environment, `${path}${suffix}`, { method: "GET" });
}

export async function stripePost(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  path: string,
  parameters: URLSearchParams,
  idempotencyKey?: string,
) {
  const init: RequestInit = {
    body: parameters,
    method: "POST",
  };
  if (idempotencyKey) {
    init.headers = { "Idempotency-Key": idempotencyKey };
  }
  return stripeRequest(environment, path, init);
}

export async function stripeDelete(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  path: string,
) {
  return stripeRequest(environment, path, { method: "DELETE" });
}

async function stripeRequest(
  environment: Pick<Bindings, "STRIPE_SECRET_KEY">,
  path: string,
  init: RequestInit,
) {
  const secret = environment.STRIPE_SECRET_KEY;
  if (!secret) {
    throw new StripeConfigurationError("Stripe billing is not configured.");
  }
  const response = await fetch(`https://api.stripe.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Stripe-Version": stripeApiVersion,
      ...(init.body
        ? { "Content-Type": "application/x-www-form-urlencoded" }
        : {}),
      ...init.headers,
    },
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = stripeErrorMessage(body);
    throw new StripeApiError(
      message ?? "Stripe rejected the billing request.",
      response.status,
    );
  }
  if (body === null) {
    throw new StripeApiError("Stripe returned an empty response.", 502);
  }
  return body;
}

function stripeErrorMessage(value: unknown) {
  if (!value || typeof value !== "object" || !("error" in value)) {
    return "Stripe rejected the billing request.";
  }
  const error = value.error;
  if (!error || typeof error !== "object" || !("message" in error)) {
    return "Stripe rejected the billing request.";
  }
  return typeof error.message === "string"
    ? error.message
    : "Stripe rejected the billing request.";
}

export async function verifyStripeWebhook(
  payload: ArrayBuffer,
  signatureHeader: string | undefined,
  secret: string | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  if (!secret) {
    throw new StripeConfigurationError(
      "Stripe webhook verification is not configured.",
    );
  }
  const signature = parseSignature(signatureHeader);
  if (
    !signature ||
    Math.abs(nowSeconds - signature.timestamp) > webhookToleranceSeconds
  ) {
    return false;
  }
  const prefix = new TextEncoder().encode(`${signature.timestamp}.`);
  const bytes = new Uint8Array(prefix.byteLength + payload.byteLength);
  bytes.set(prefix);
  bytes.set(new Uint8Array(payload), prefix.byteLength);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  return signature.values.some((value) =>
    constantTimeEqual(digest, hexBytes(value)),
  );
}

function parseSignature(value: string | undefined) {
  if (!value) return null;
  let timestamp: number | undefined;
  const values: string[] = [];
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const field = part.slice(separator + 1).trim();
    if (key === "t") timestamp = Number(field);
    if (key === "v1") values.push(field);
  }
  return Number.isSafeInteger(timestamp) && values.length > 0
    ? { timestamp: timestamp as number, values }
    : null;
}

function hexBytes(value: string) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return new Uint8Array();
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}
