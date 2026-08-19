import { describe, expect, it } from "bun:test";
import {
  canLeaveOrganization,
  canManageOrganization,
  createOrganizationSlug,
  resolveActiveOrganizationId,
} from "./organizationState";

const organizations = [
  { id: "personal", name: "Personal" },
  { id: "company", name: "Company" },
];

describe("organization state", () => {
  it("creates a readable, collision-resistant organization slug", () => {
    expect(createOrganizationSlug("North & West, LLC", "ABC-12345-extra")).toBe(
      "north-west-llc-abc12345",
    );
    expect(createOrganizationSlug("安全", "12345678")).toBe(
      "organization-12345678",
    );
  });

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

  it("lets members leave while preserving an owner and fallback workspace", () => {
    expect(canLeaveOrganization("member", ["owner", "member"], true)).toBe(
      true,
    );
    expect(canLeaveOrganization("owner", ["owner", "owner"], true)).toBe(true);
    expect(canLeaveOrganization("owner", ["owner", "member"], true)).toBe(
      false,
    );
    expect(canLeaveOrganization("member", ["owner", "member"], false)).toBe(
      false,
    );
  });
});
