import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "./db";
import { auditIssueImageUploadGraceMilliseconds } from "./objectLifecycle";
import { deletedObjectCleanup } from "./schema";
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
  const db = getDb(environment.DB);
  const cleanupToken = crypto.randomUUID();
  const claimed = await db
    .update(deletedObjectCleanup)
    .set({ cleanupToken, cleanupClaimedAt: new Date().toISOString() })
    .where(
      and(
        eq(deletedObjectCleanup.id, object.id),
        or(
          isNull(deletedObjectCleanup.cleanupToken),
          claimedBefore(abandonedClaimCutoff),
        ),
      ),
    )
    .returning({ objectKey: deletedObjectCleanup.objectKey })
    .get();
  if (!claimed) return false;

  await environment.STORAGE.delete(claimed.objectKey);
  const deleted = await db
    .delete(deletedObjectCleanup)
    .where(
      and(
        eq(deletedObjectCleanup.id, object.id),
        eq(deletedObjectCleanup.cleanupToken, cleanupToken),
      ),
    )
    .run();
  return Number(deleted.meta.changes) === 1;
}

function claimedBefore(cutoff: string) {
  return sql`datetime(${deletedObjectCleanup.cleanupClaimedAt}) <= datetime(${cutoff})`;
}

/** Delete R2 bytes whose D1 object rows were removed by a cascade. */
export async function purgeDeletedObjects(
  environment: Pick<Bindings, "DB" | "STORAGE">,
  cutoffs = defaultCleanupCutoffs(),
) {
  const objects: DeletedObjectCleanup[] = await getDb(environment.DB)
    .select({ id: deletedObjectCleanup.id })
    .from(deletedObjectCleanup)
    .where(
      and(
        sql`datetime(${deletedObjectCleanup.deletedAt}) <= datetime(${cutoffs.deletedBefore})`,
        or(
          isNull(deletedObjectCleanup.cleanupToken),
          claimedBefore(cutoffs.abandonedClaimedBefore),
        ),
      ),
    )
    .orderBy(asc(deletedObjectCleanup.deletedAt), asc(deletedObjectCleanup.id))
    .limit(cleanupBatchSize);
  let firstFailure: unknown;
  let purged = 0;
  for (const object of objects) {
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
