export function addAccountPath(returnTo: string) {
  const parameters = new URLSearchParams({ returnTo });
  return `/add-account?${parameters.toString()}`;
}

export function accountReturnPath(search: string, origin: string) {
  const returnTo = new URLSearchParams(search).get("returnTo");
  if (!returnTo) return "/";
  try {
    const target = new URL(returnTo, origin);
    if (target.origin !== origin) return "/";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/";
  }
}

export function workspaceContentKey(
  pathname: string,
  userId: string,
  organizationId: string | undefined,
) {
  if (pathname === "/invite") return `organization-invitation:${userId}`;
  return `${userId}:${organizationId ?? ""}`;
}
