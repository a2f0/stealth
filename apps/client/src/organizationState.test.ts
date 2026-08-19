import { describe, expect, it } from "bun:test";
import {
  canManageOrganization,
  resolveActiveOrganizationId,
} from "./organizationState";

const organizations = [
  { id: "personal", name: "Personal" },
  { id: "company", name: "Company" },
];

describe("organization state", () => {
  it("uses the one active membership before the default", () => {
    expect(
      resolveActiveOrganizationId("company", "personal", organizations),
    ).toBe("company");
  });

  it("falls back to a valid default membership", () => {
    expect(
      resolveActiveOrganizationId("removed", "personal", organizations),
    ).toBe("personal");
  });

  it("only lets organization managers invite members", () => {
    expect(canManageOrganization("owner")).toBe(true);
    expect(canManageOrganization("admin,member")).toBe(true);
    expect(canManageOrganization("member")).toBe(false);
  });
});
