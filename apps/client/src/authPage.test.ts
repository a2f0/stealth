import { describe, expect, it } from "bun:test";
import { requiresTwoFactor } from "./AuthPage";

describe("MFA sign-in response", () => {
  it("continues to the second factor only for an explicit MFA redirect", () => {
    expect(requiresTwoFactor({ twoFactorRedirect: true })).toBe(true);
    expect(requiresTwoFactor({ twoFactorRedirect: false })).toBe(false);
    expect(requiresTwoFactor({ token: "session-token" })).toBe(false);
    expect(requiresTwoFactor(null)).toBe(false);
  });
});
