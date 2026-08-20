export function organizationInboxAddress(
  organizationId: string,
  inboundEmailDomain: string,
) {
  return `upload+${organizationId}@${normalizeDomain(inboundEmailDomain)}`;
}

export function organizationIdForInboundAddress(
  address: string,
  inboundEmailDomain: string,
) {
  const separator = address.lastIndexOf("@");
  if (separator <= 0) return undefined;
  const domain = address.slice(separator + 1).toLowerCase();
  if (domain !== normalizeDomain(inboundEmailDomain)) return undefined;
  const localPart = address.slice(0, separator);
  const prefix = "upload+";
  if (!localPart.toLowerCase().startsWith(prefix)) return undefined;
  return localPart.slice(prefix.length) || undefined;
}

function normalizeDomain(domain: string) {
  return domain.trim().toLowerCase().replace(/^@/, "");
}
