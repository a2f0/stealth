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
