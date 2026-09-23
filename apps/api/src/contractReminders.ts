import {
  type ContractEnvironment,
  findContractById,
  listRecipients,
  notifyRecipients,
} from "./contractRecords";

const reminderBatchSize = 50;

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
       WHERE contract.status = 'sent'
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
