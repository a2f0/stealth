import { describe, expect, it } from "bun:test";
import {
  accountReturnPath,
  addAccountPath,
  invitationIdForPath,
  workspaceContentKey,
} from "./accountNavigation";

const origin = "https://app.tearleads.com";

describe("account navigation", () => {
  it("preserves an invitation while another account signs in", () => {
    const returnTo = "/invite?id=invitation-id";
    const addPath = addAccountPath(returnTo);

    expect(addPath).toBe(
      "/add-account?returnTo=%2Finvite%3Fid%3Dinvitation-id",
    );
    expect(accountReturnPath(new URL(addPath, origin).search, origin)).toBe(
      returnTo,
    );
  });

  it("rejects external return destinations", () => {
    expect(
      accountReturnPath("?returnTo=https%3A%2F%2Fevil.example", origin),
    ).toBe("/");
    expect(accountReturnPath("?returnTo=%2F%2Fevil.example", origin)).toBe("/");
  });

  it("finds an invitation in a safe return path", () => {
    expect(invitationIdForPath("/invite?id=invitation-id", origin)).toBe(
      "invitation-id",
    );
    expect(invitationIdForPath("/organization?id=invitation-id", origin)).toBe(
      undefined,
    );
    expect(
      invitationIdForPath(
        "https://evil.example/invite?id=invitation-id",
        origin,
      ),
    ).toBe(undefined);
  });

  it("reloads invitations when the active account changes", () => {
    expect(workspaceContentKey("/invite", "user-one", "organization")).not.toBe(
      workspaceContentKey("/invite", "user-two", "organization"),
    );
    expect(workspaceContentKey("/invite", "user-one", "organization-one")).toBe(
      workspaceContentKey("/invite", "user-one", "organization-two"),
    );
  });
});
