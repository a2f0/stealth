import type { Bindings } from "./types";

const cleanupBatchSize = 25;
const abandonedClaimMilliseconds = 5 * 60 * 1000;

interface DeletedObjectCleanup {
  id: string;
}

async function purgeDeletedObject(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  object: DeletedObjectCleanup,
  abandonedClaimCutoff: string,
) {
  const cleanupToken = crypto.randomUUID();
  const claimed = await environment.DB.prepare(
    `UPDATE deleted_object_cleanup
     SET cleanup_token = ?, cleanup_claimed_at = ?
     WHERE id = ?
       AND (
         cleanup_token IS NULL OR datetime(cleanup_claimed_at) <= datetime(?)
       )
     RETURNING object_key`,
  )
    .bind(
      cleanupToken,
      new Date().toISOString(),
      object.id,
      abandonedClaimCutoff,
    )
    .first<{ object_key: string }>();
  if (!claimed) return false;

  await environment.STORAGE.delete(claimed.object_key);
  const deleted = await environment.DB.prepare(
    `DELETE FROM deleted_object_cleanup
     WHERE id = ? AND cleanup_token = ?`,
  )
    .bind(object.id, cleanupToken)
    .run();
  return Number(deleted.meta.changes) === 1;
}

/** Delete R2 bytes whose D1 object rows were removed by a cascade. */
export async function purgeDeletedObjects(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  abandonedClaimCutoff = new Date(
    Date.now() - abandonedClaimMilliseconds,
  ).toISOString(),
) {
  const result = await environment.DB.prepare(
    `SELECT id FROM deleted_object_cleanup
     WHERE cleanup_token IS NULL
       OR datetime(cleanup_claimed_at) <= datetime(?)
     ORDER BY deleted_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(abandonedClaimCutoff, cleanupBatchSize)
    .all<DeletedObjectCleanup>();
  let firstFailure: unknown;
  let purged = 0;
  for (const object of result.results) {
    try {
      if (await purgeDeletedObject(environment, object, abandonedClaimCutoff)) {
        purged += 1;
      }
    } catch (cause) {
      firstFailure ??= cause;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
  return purged;
}
