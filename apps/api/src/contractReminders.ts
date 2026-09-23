import {
  advanceContract,
  type ContractEnvironment,
  findContractById,
  listRecipients,
  notifyRecipients,
} from "./contractRecords";

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
  const database = environment.DB;
  const stalled = await database
    .prepare(
      `SELECT contract.id FROM contracts AS contract
       JOIN organization ON organization.id = contract.organization_id
       WHERE contract.status = 'sent' AND organization.deletedAt IS NULL
         AND contract.resume_attempts < ?
         AND NOT EXISTS (
           SELECT 1 FROM contract_recipients
           WHERE contract_id = contract.id AND status IN ('sent', 'viewed')
         )
       ORDER BY contract.resume_attempted_at IS NOT NULL,
                contract.resume_attempted_at ASC
       LIMIT ?`,
    )
    .bind(maxResumeAttempts, resumeBatchSize)
    .all<{ id: string }>();
  const leaseExpired = new Date(now.getTime() - resumeLeaseMs).toISOString();
  let resumed = 0;
  for (const { id } of stalled.results) {
    const claim = await database
      .prepare(
        `UPDATE contracts
         SET resume_attempts = resume_attempts + 1, resume_attempted_at = ?
         WHERE id = ? AND status = 'sent'
           AND (resume_attempted_at IS NULL OR resume_attempted_at < ?)`,
      )
      .bind(now.toISOString(), id, leaseExpired)
      .run();
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
  const due = await database
    .prepare(
      `SELECT recipient.id, recipient.contract_id,
              COALESCE(recipient.last_reminded_at, recipient.notified_at)
                AS last_emailed_at
       FROM contract_recipients AS recipient
       JOIN contracts AS contract ON contract.id = recipient.contract_id
       JOIN organization ON organization.id = contract.organization_id
       WHERE contract.status = 'sent' AND organization.deletedAt IS NULL
         AND contract.reminder_interval_days IS NOT NULL
         AND recipient.status IN ('sent', 'viewed')
         AND julianday(?) - julianday(
           COALESCE(recipient.last_reminded_at, recipient.notified_at)
         ) >= contract.reminder_interval_days
       ORDER BY last_emailed_at ASC
       LIMIT ?`,
    )
    .bind(now.toISOString(), reminderBatchSize)
    .all<{ contract_id: string; id: string; last_emailed_at: string }>();
  const claimed = new Map<string, Set<string>>();
  for (const recipient of due.results) {
    const claim = await database
      .prepare(
        `UPDATE contract_recipients SET last_reminded_at = ?
         WHERE id = ?
           AND COALESCE(last_reminded_at, notified_at) = ?`,
      )
      .bind(now.toISOString(), recipient.id, recipient.last_emailed_at)
      .run();
    if (claim.meta.changes !== 1) continue;
    const ids = claimed.get(recipient.contract_id) ?? new Set<string>();
    ids.add(recipient.id);
    claimed.set(recipient.contract_id, ids);
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
