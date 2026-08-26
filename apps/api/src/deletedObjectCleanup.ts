import { auditIssueImageUploadGraceMilliseconds } from "./objectLifecycle";
import type { Bindings } from "./types";

const cleanupBatchSize = 25;
const abandonedClaimMilliseconds = 5 * 60 * 1000;

interface DeletedObjectCleanup {
  id: string;
}

interface DeletedObjectCleanupCutoffs {
  abandonedClaimedBefore: string;
  deletedBefore: string;
}

function defaultCleanupCutoffs(): DeletedObjectCleanupCutoffs {
  const now = Date.now();
  return {
    abandonedClaimedBefore: new Date(
      now - abandonedClaimMilliseconds,
    ).toISOString(),
    // An organization can disappear while an already-authorized upload is
    // writing R2. Keep its durable tombstone until every upload lease that was
    // live at deletion time has expired.
    deletedBefore: new Date(
      now - auditIssueImageUploadGraceMilliseconds,
    ).toISOString(),
  };
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
  cutoffs = defaultCleanupCutoffs(),
) {
  const result = await environment.DB.prepare(
    `SELECT id FROM deleted_object_cleanup
     WHERE datetime(deleted_at) <= datetime(?)
       AND (
         cleanup_token IS NULL
         OR datetime(cleanup_claimed_at) <= datetime(?)
       )
     ORDER BY deleted_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(
      cutoffs.deletedBefore,
      cutoffs.abandonedClaimedBefore,
      cleanupBatchSize,
    )
    .all<DeletedObjectCleanup>();
  let firstFailure: unknown;
  let purged = 0;
  for (const object of result.results) {
    try {
      if (
        await purgeDeletedObject(
          environment,
          object,
          cutoffs.abandonedClaimedBefore,
        )
      ) {
        purged += 1;
      }
    } catch (cause) {
      firstFailure ??= cause;
    }
  }
  if (firstFailure !== undefined) throw firstFailure;
  return purged;
}
