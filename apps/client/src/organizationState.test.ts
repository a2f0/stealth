import { describe, expect, it } from "bun:test";
import {
  assignableOrganizationRoles,
  canDeleteOrganization,
  canLeaveOrganizationWithOwnerCount,
  canManageOrganization,
  createOrganizationSlug,
  editableOrganizationRoles,
  organizationRoleValue,
  organizationSettingsPage,
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

  it("does not retain a stale organization pointer when no memberships remain", () => {
    expect(resolveActiveOrganizationId("removed", "removed", [])).toBe(
      undefined,
    );
  });

  it("routes organization settings to focused sub-pages", () => {
    expect(organizationSettingsPage("/organization")).toBe("general");
    expect(organizationSettingsPage("/organization/people")).toBe("people");
    expect(organizationSettingsPage("/organization/access")).toBe("access");
    expect(organizationSettingsPage("/organization/unknown")).toBe("general");
  });

  it("only lets organization managers invite members", () => {
    expect(canManageOrganization("owner")).toBe(true);
    expect(canManageOrganization("admin,member")).toBe(true);
    expect(canManageOrganization("member")).toBe(false);
  });

  it("only lets an owner delete an organization", () => {
    expect(canDeleteOrganization("owner")).toBe(true);
    expect(canDeleteOrganization("admin")).toBe(false);
    expect(canDeleteOrganization("member,admin")).toBe(false);
  });

  it("only lets owners assign the owner role in an invitation", () => {
    expect(assignableOrganizationRoles("owner")).toEqual([
      "member",
      "admin",
      "owner",
    ]);
    expect(assignableOrganizationRoles("admin")).toEqual(["member", "admin"]);
    expect(assignableOrganizationRoles("member")).toEqual([]);
  });

  it("offers safe role changes for existing organization members", () => {
    expect(
      editableOrganizationRoles("admin", "member", ["owner", "admin"]),
    ).toEqual(["member", "admin"]);
    expect(
      editableOrganizationRoles("admin", "owner", ["owner", "admin"]),
    ).toEqual([]);
    expect(
      editableOrganizationRoles("owner", "member", ["owner", "member"]),
    ).toEqual(["member", "admin", "owner"]);
    expect(
      editableOrganizationRoles("owner", "owner", ["owner", "member"]),
    ).toEqual(["owner"]);
    expect(
      editableOrganizationRoles("owner", "owner", ["owner", "owner"]),
    ).toEqual(["member", "admin", "owner"]);
  });

  it("normalizes combined organization roles for the role control", () => {
    expect(organizationRoleValue("member")).toBe("member");
    expect(organizationRoleValue("member,admin")).toBe("admin");
    expect(organizationRoleValue("admin,owner")).toBe("owner");
  });

  it("lets members leave while preserving an owner and fallback workspace", () => {
    expect(canLeaveOrganizationWithOwnerCount("member", 1, true)).toBe(true);
    expect(canLeaveOrganizationWithOwnerCount("owner", 2, true)).toBe(true);
    expect(canLeaveOrganizationWithOwnerCount("owner", 1, true)).toBe(false);
    expect(canLeaveOrganizationWithOwnerCount("member", 1, false)).toBe(false);
  });
});
