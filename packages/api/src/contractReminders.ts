import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import {
  advanceContract,
  type ContractEnvironment,
  findContractById,
  listRecipients,
  notifyRecipients,
} from "./contractRecords";
import { getDb } from "./db";
import { contractRecipients, contracts, organization } from "./schema";

const reminderBatchSize = 50;
const resumeBatchSize = 5;
const maxResumeAttempts = 5;
const resumeLeaseMs = 30 * 60 * 1000;

/**
 * The hourly contract upkeep. Reminders go first, so a stalled contract that
 * exhausts the Worker cannot hold them up.
 */
export async function maintainContracts(
  environment: ContractEnvironment,
  now = new Date(),
) {
  const reminded = await sendContractReminders(environment, now);
  await resumeStalledContracts(environment, now);
  return reminded;
}

/**
 * Finishes what a signature started when it could not: emails the next
 * sequential signers, or completes a contract everyone has signed. Each
 * attempt is claimed before it is made, so a document that exhausts the
 * Worker moves to the back of the queue and is abandoned after a few tries.
 */
export async function resumeStalledContracts(
  environment: ContractEnvironment,
  now = new Date(),
) {
  const db = getDb(environment.DB);
  const stalled = await db
    .select({ id: contracts.id })
    .from(contracts)
    .innerJoin(organization, eq(organization.id, contracts.organizationId))
    .where(
      and(
        eq(contracts.status, "sent"),
        isNull(organization.deletedAt),
        lt(contracts.resumeAttempts, maxResumeAttempts),
        notExists(
          db
            .select({ one: sql`1` })
            .from(contractRecipients)
            .where(
              and(
                eq(contractRecipients.contractId, contracts.id),
                inArray(contractRecipients.status, ["sent", "viewed"]),
              ),
            ),
        ),
      ),
    )
    .orderBy(
      isNotNull(contracts.resumeAttemptedAt),
      asc(contracts.resumeAttemptedAt),
    )
    .limit(resumeBatchSize);
  const leaseExpired = new Date(now.getTime() - resumeLeaseMs).toISOString();
  let resumed = 0;
  for (const { id } of stalled) {
    const claim = await db
      .update(contracts)
      .set({
        resumeAttemptedAt: now.toISOString(),
        resumeAttempts: sql`${contracts.resumeAttempts} + 1`,
      })
      .where(
        and(
          eq(contracts.id, id),
          eq(contracts.status, "sent"),
          or(
            isNull(contracts.resumeAttemptedAt),
            lt(contracts.resumeAttemptedAt, leaseExpired),
          ),
        ),
      );
    if (claim.meta.changes !== 1) continue;
    try {
      await advanceContract(environment, id);
      resumed += 1;
    } catch (cause) {
      console.error("A stalled contract could not be resumed.", cause);
    }
  }
  return resumed;
}

/**
 * Reminds signers whose contract's reminder interval has passed since they
 * were last emailed. Each recipient is claimed before sending, so overlapping
 * runs cannot remind anyone twice.
 */
export async function sendContractReminders(
  environment: ContractEnvironment,
  now = new Date(),
) {
  const database = environment.DB;
  const db = getDb(database);
  const lastEmailedAt = sql<string>`coalesce(${contractRecipients.lastRemindedAt}, ${contractRecipients.notifiedAt})`;
  const due = await db
    .select({
      contractId: contractRecipients.contractId,
      id: contractRecipients.id,
      lastEmailedAt,
    })
    .from(contractRecipients)
    .innerJoin(contracts, eq(contracts.id, contractRecipients.contractId))
    .innerJoin(organization, eq(organization.id, contracts.organizationId))
    .where(
      and(
        eq(contracts.status, "sent"),
        isNull(organization.deletedAt),
        isNotNull(contracts.reminderIntervalDays),
        inArray(contractRecipients.status, ["sent", "viewed"]),
        gte(
          sql`julianday(${now.toISOString()}) - julianday(${lastEmailedAt})`,
          contracts.reminderIntervalDays,
        ),
      ),
    )
    .orderBy(asc(lastEmailedAt))
    .limit(reminderBatchSize);
  const claimed = new Map<string, Set<string>>();
  for (const recipient of due) {
    const claim = await db
      .update(contractRecipients)
      .set({ lastRemindedAt: now.toISOString() })
      .where(
        and(
          eq(contractRecipients.id, recipient.id),
          eq(lastEmailedAt, recipient.lastEmailedAt),
        ),
      );
    if (claim.meta.changes !== 1) continue;
    const ids = claimed.get(recipient.contractId) ?? new Set<string>();
    ids.add(recipient.id);
    claimed.set(recipient.contractId, ids);
  }
  let reminded = 0;
  for (const [contractId, ids] of claimed) {
    const contract = await findContractById(database, contractId);
    if (contract?.status !== "sent") continue;
    const recipients = (await listRecipients(database, contractId)).filter(
      ({ id }) => ids.has(id),
    );
    reminded += await notifyRecipients(
      environment,
      contract,
      recipients,
      true,
      now,
    );
  }
  return reminded;
}
