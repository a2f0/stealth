export interface WorkspaceOrganization {
  id: string;
  name: string;
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
  return (
    role
      ?.split(",")
      .some((value) => value.trim() === "owner" || value.trim() === "admin") ??
    false
  );
}
