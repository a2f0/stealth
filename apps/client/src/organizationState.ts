export interface WorkspaceOrganization {
  id: string;
  name: string;
}

type OrganizationSettingsPage = "access" | "general" | "people";

export function isOrganizationPath(pathname: string) {
  return pathname === "/organization" || pathname.startsWith("/organization/");
}

export function organizationSettingsPage(
  pathname: string,
): OrganizationSettingsPage {
  if (pathname === "/organization/people") return "people";
  if (pathname === "/organization/access") return "access";
  return "general";
}

export const organizationInvitationRoles = [
  "member",
  "admin",
  "owner",
] as const;

export type OrganizationInvitationRole =
  (typeof organizationInvitationRoles)[number];

export function createOrganizationSlug(name: string, suffix: string) {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  const safeSuffix = suffix
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  return `${base || "organization"}-${safeSuffix}`;
}

export function resolveActiveOrganizationId(
  activeOrganizationId: string | null | undefined,
  defaultOrganizationId: string | null | undefined,
  organizations: WorkspaceOrganization[],
) {
  if (organizations.length === 0) {
    return activeOrganizationId ?? defaultOrganizationId ?? undefined;
  }
  if (
    activeOrganizationId &&
    organizations.some(({ id }) => id === activeOrganizationId)
  ) {
    return activeOrganizationId;
  }
  if (
    defaultOrganizationId &&
    organizations.some(({ id }) => id === defaultOrganizationId)
  ) {
    return defaultOrganizationId;
  }
  return organizations[0]?.id;
}

export function canManageOrganization(role: string | null | undefined) {
  return hasOrganizationRole(role, "owner", "admin");
}

export function assignableOrganizationRoles(
  role: string | null | undefined,
): OrganizationInvitationRole[] {
  if (hasOrganizationRole(role, "owner")) {
    return [...organizationInvitationRoles];
  }
  if (hasOrganizationRole(role, "admin")) return ["member", "admin"];
  return [];
}

export function editableOrganizationRoles(
  managerRole: string | null | undefined,
  memberRole: string,
  memberRoles: string[],
): OrganizationInvitationRole[] {
  const assignableRoles = assignableOrganizationRoles(managerRole);
  if (
    hasOrganizationRole(memberRole, "owner") &&
    !assignableRoles.includes("owner")
  ) {
    return [];
  }
  const ownerCount = memberRoles.filter((role) =>
    hasOrganizationRole(role, "owner"),
  ).length;
  if (hasOrganizationRole(memberRole, "owner") && ownerCount <= 1) {
    return ["owner"];
  }
  return assignableRoles;
}

export function organizationRoleValue(
  role: string,
): OrganizationInvitationRole {
  if (hasOrganizationRole(role, "owner")) return "owner";
  if (hasOrganizationRole(role, "admin")) return "admin";
  return "member";
}

export function canLeaveOrganizationWithOwnerCount(
  role: string | null | undefined,
  ownerCount: number,
  hasAnotherOrganization: boolean,
) {
  if (!hasAnotherOrganization) return false;
  if (!hasOrganizationRole(role, "owner")) return true;
  return ownerCount > 1;
}

function hasOrganizationRole(
  role: string | null | undefined,
  ...expectedRoles: string[]
) {
  return (
    role?.split(",").some((value) => expectedRoles.includes(value.trim())) ??
    false
  );
}
