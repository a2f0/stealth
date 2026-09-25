/**
 * Signing links carry a token derived from a per-recipient nonce with the
 * auth secret. Reminders can therefore re-send the same link while only the
 * token's hash is stored. Rotating the secret invalidates outstanding links.
 */
export async function signingToken(
  secret: string,
  recipientId: string,
  nonce: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `tearleads-contract-signing:v1:${recipientId}:${nonce}`,
    ),
  );
  return base64Url(new Uint8Array(mac));
}

export async function signingTokenHash(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return base64Url(new Uint8Array(digest));
}

export function newTokenNonce() {
  return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** A 32-byte token in unpadded base64url. */
export function isSigningToken(value: string) {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
