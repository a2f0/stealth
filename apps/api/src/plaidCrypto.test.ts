import { describe, expect, it } from "bun:test";
import { decryptToken, encryptToken } from "./plaidCrypto";

const secret = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

describe("Plaid token encryption", () => {
  it("encrypts tokens with authenticated record context", async () => {
    const encrypted = await encryptToken(
      "access-sandbox-secret",
      secret,
      "organization:item",
    );

    expect(encrypted.ciphertext).not.toContain("access-sandbox-secret");
    expect(await decryptToken(encrypted, secret, "organization:item")).toBe(
      "access-sandbox-secret",
    );
    expect(
      decryptToken(encrypted, secret, "different-organization:item"),
    ).rejects.toThrow();
  });
});
