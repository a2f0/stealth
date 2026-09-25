/**
 * The message to show after the inbox listing loads. A message requested by
 * link wins even when it is older than the newest messages the listing
 * returns; the current selection stays while it is listed or was itself
 * opened by link; otherwise the newest message is shown.
 */
export function selectEmailId(
  emails: { id: string }[],
  current: string | undefined,
  requested: string | undefined,
  openedByLink: string | undefined,
) {
  if (requested) return requested;
  if (
    current &&
    (current === openedByLink || emails.some(({ id }) => id === current))
  ) {
    return current;
  }
  return emails[0]?.id;
}
