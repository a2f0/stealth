import { describe, expect, it } from "bun:test";
import {
  type AccountSession,
  accountSessionsFor,
  isInvalidMultiSessionToken,
} from "./accountSessions";

describe("account sessions", () => {
  it("keeps the active account first and one session per user", () => {
    const active = session("active", "user-2", "Zoe", "zoe@example.com");
    const accounts = accountSessionsFor(active, [
      session("older-active", "user-2", "Zoe", "zoe@example.com"),
      session("one", "user-1", "Alex", "alex@example.com"),
      session("three", "user-3", "Morgan", "morgan@example.com"),
    ]);

    expect(accounts.map(({ token }) => token)).toEqual([
      "active",
      "one",
      "three",
    ]);
  });

  it("recognizes a missing multi-session cookie for fallback sign-out", () => {
    expect(isInvalidMultiSessionToken({ code: "INVALID_SESSION_TOKEN" })).toBe(
      true,
    );
    expect(isInvalidMultiSessionToken({ code: "UNAUTHORIZED" })).toBe(false);
    expect(isInvalidMultiSessionToken(null)).toBe(false);
  });
});

function session(
  token: string,
  id: string,
  name: string,
  email: string,
): AccountSession {
  return { token, user: { email, id, name } };
}
