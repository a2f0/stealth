import { describe, expect, it } from "bun:test";
import { passwordSignInInput, requiresTwoFactor } from "./AuthPage";

describe("MFA sign-in response", () => {
  it("continues to the second factor only for an explicit MFA redirect", () => {
    expect(requiresTwoFactor({ twoFactorRedirect: true })).toBe(true);
    expect(requiresTwoFactor({ twoFactorRedirect: false })).toBe(false);
    expect(requiresTwoFactor({ token: "session-token" })).toBe(false);
    expect(requiresTwoFactor(null)).toBe(false);
  });

  it("defers the session refresh until every authentication factor passes", () => {
    expect(passwordSignInInput("person@example.com", "password")).toEqual({
      email: "person@example.com",
      fetchOptions: { disableSignal: true },
      password: "password",
    });
  });
});
