import type { MouseEvent } from "react";

/** The library root, or one folder within it. */
export function libraryPath(folderId?: string) {
  return folderId ? `/library/${encodeURIComponent(folderId)}` : "/";
}

/**
 * The folder id in a `/library/<id>` path, if any. A malformed escape is kept
 * as typed, so the page reports an unavailable folder instead of throwing.
 */
export function libraryFolderIdForPath(pathname: string) {
  const segment = /^\/library\/([^/]+)\/?$/.exec(pathname)?.[1];
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The equipment list, or one item of equipment. */
export function equipmentPath(equipmentId?: string) {
  return equipmentId
    ? `/equipment/${encodeURIComponent(equipmentId)}`
    : "/equipment";
}

export function isEquipmentPath(pathname: string) {
  return pathname === "/equipment" || pathname.startsWith("/equipment/");
}

/** The equipment id in an `/equipment/<id>` path, if any. */
export function equipmentIdForPath(pathname: string) {
  const segment = /^\/equipment\/([^/]+)\/?$/.exec(pathname)?.[1];
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The contract list, or one contract. */
export function contractPath(contractId?: string) {
  return contractId
    ? `/contracts/${encodeURIComponent(contractId)}`
    : "/contracts";
}

export function isContractsPath(pathname: string) {
  return pathname === "/contracts" || pathname.startsWith("/contracts/");
}

/** The contract id in a `/contracts/<id>` path, if any. */
export function contractIdForPath(pathname: string) {
  const segment = /^\/contracts\/([^/]+)\/?$/.exec(pathname)?.[1];
  if (!segment) return undefined;
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The token in a public `/sign/<token>` signing link, if the path is one. */
export function signingTokenForPath(pathname: string) {
  return /^\/sign\/([A-Za-z0-9_-]{43})\/?$/.exec(pathname)?.[1];
}

/** Opens one message in the inbox. */
export function inboxEmailPath(emailId: string) {
  return `/inbox?${new URLSearchParams({ email: emailId })}`;
}

/**
 * Follows an in-app link without a page load, leaving modified clicks
 * (new tab, new window) to the browser.
 */
export function handleNavigation(
  event: MouseEvent<HTMLAnchorElement>,
  pathname: string,
  onNavigate: (pathname: string) => void,
) {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  onNavigate(pathname);
}
