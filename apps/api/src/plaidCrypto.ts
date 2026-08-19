const algorithm = "AES-GCM";

interface EncryptedToken {
  ciphertext: string;
  iv: string;
}

export async function encryptToken(
  value: string,
  secret: string,
  context: string,
): Promise<EncryptedToken> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { additionalData: text(context), iv, name: algorithm },
    await encryptionKey(secret),
    text(value),
  );
  return { ciphertext: toBase64(ciphertext), iv: toBase64(iv) };
}

export async function decryptToken(
  encrypted: EncryptedToken,
  secret: string,
  context: string,
) {
  const plaintext = await crypto.subtle.decrypt(
    {
      additionalData: text(context),
      iv: fromBase64(encrypted.iv),
      name: algorithm,
    },
    await encryptionKey(secret),
    fromBase64(encrypted.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

async function encryptionKey(secret: string) {
  const bytes = fromBase64(secret);
  if (bytes.byteLength !== 32) {
    throw new Error("PLAID_TOKEN_ENCRYPTION_KEY must be 32 base64 bytes.");
  }
  return crypto.subtle.importKey("raw", bytes, algorithm, false, [
    "decrypt",
    "encrypt",
  ]);
}

function text(value: string) {
  return new TextEncoder().encode(value);
}

function toBase64(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
