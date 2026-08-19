export interface WorkspaceOrganization {
  id: string;
  name: string;
}

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

export function canLeaveOrganization(
  role: string | null | undefined,
  memberRoles: string[],
  hasAnotherOrganization: boolean,
) {
  if (!hasAnotherOrganization) return false;
  if (!hasOrganizationRole(role, "owner")) return true;
  return (
    memberRoles.filter((memberRole) => hasOrganizationRole(memberRole, "owner"))
      .length > 1
  );
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
