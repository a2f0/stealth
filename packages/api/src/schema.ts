import {
  customType,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

// The SQL files in migrations/ own the database structure — constraints,
// indexes, foreign keys, and triggers included. This module mirrors only the
// columns so queries are typed; schema.test.ts fails when the two drift.

// Better Auth declares its timestamps as `date`. It stores ISO strings, so the
// column passes values through unchanged instead of coercing them.
const date = customType<{ data: string; driverData: string }>({
  dataType: () => "date",
});

// Better Auth declares rate-limit timestamps as `bigint` milliseconds.
const bigint = customType<{ data: number; driverData: number }>({
  dataType: () => "bigint",
});

export const user = sqliteTable("user", {
  id: text().primaryKey(),
  name: text().notNull(),
  email: text().notNull(),
  emailVerified: integer().notNull(),
  image: text(),
  createdAt: date().notNull(),
  updatedAt: date().notNull(),
  role: text(),
  banned: integer(),
  banReason: text(),
  banExpires: date(),
  defaultOrganizationId: text(),
  twoFactorEnabled: integer().default(0).notNull(),
  termsAccepted: integer(),
  termsAcceptedAt: date(),
  termsVersion: text(),
  defaultOrganizationPinned: integer().default(0).notNull(),
});

export const session = sqliteTable("session", {
  id: text().primaryKey(),
  expiresAt: date().notNull(),
  token: text().notNull(),
  createdAt: date().notNull(),
  updatedAt: date().notNull(),
  ipAddress: text(),
  userAgent: text(),
  userId: text().notNull(),
  impersonatedBy: text(),
  activeOrganizationId: text(),
  activeTeamId: text(),
  twoFactorVerified: integer().default(0).notNull(),
});

export const account = sqliteTable("account", {
  id: text().primaryKey(),
  issuer: text().notNull(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: text().notNull(),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: date(),
  refreshTokenExpiresAt: date(),
  scope: text(),
  password: text(),
  createdAt: date().notNull(),
  updatedAt: date().notNull(),
});

export const verification = sqliteTable("verification", {
  id: text().primaryKey(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: date().notNull(),
  createdAt: date().notNull(),
  updatedAt: date().notNull(),
});

export const rateLimit = sqliteTable("rateLimit", {
  id: text().primaryKey(),
  key: text().notNull(),
  count: integer().notNull(),
  lastRequest: bigint().notNull(),
});

export const organization = sqliteTable("organization", {
  id: text().primaryKey(),
  name: text().notNull(),
  slug: text().notNull(),
  logo: text(),
  createdAt: date().notNull(),
  metadata: text(),
  deletedAt: date(),
  deletedByUserId: text(),
});

export const member = sqliteTable("member", {
  id: text().primaryKey(),
  organizationId: text().notNull(),
  userId: text().notNull(),
  role: text().notNull(),
  createdAt: date().notNull(),
  twoFactorRequired: integer().default(0).notNull(),
});

export const invitation = sqliteTable("invitation", {
  id: text().primaryKey(),
  organizationId: text().notNull(),
  email: text().notNull(),
  role: text(),
  status: text().notNull(),
  expiresAt: date().notNull(),
  createdAt: date().notNull(),
  inviterId: text().notNull(),
  teamId: text(),
});

export const auditTemplates = sqliteTable("audit_templates", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text().notNull(),
  description: text().notNull(),
  definition: text().notNull(),
  status: text().default("draft").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const audits = sqliteTable("audits", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  templateId: text("template_id"),
  templateName: text("template_name").notNull(),
  definition: text().notNull(),
  responses: text().default("{}").notNull(),
  status: text().default("in_progress").notNull(),
  startedBy: text("started_by").notNull(),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  templateFamilyId: text("template_family_id"),
  templateVersionId: text("template_version_id"),
  templateVersion: integer("template_version"),
});

export const auditIssues = sqliteTable("audit_issues", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  auditId: text("audit_id").notNull(),
  itemId: text("item_id").notNull(),
  title: text().notNull(),
  description: text().default("").notNull(),
  priority: text().default("medium").notNull(),
  status: text().default("open").notNull(),
  assignedTo: text("assigned_to"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const objects = sqliteTable("objects", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  objectKey: text("object_key").notNull(),
  filename: text().notNull(),
  contentType: text("content_type").notNull(),
  size: integer().notNull(),
  createdAt: text("created_at").notNull(),
  kind: text().default("library").notNull(),
  deletionPending: integer("deletion_pending").default(0).notNull(),
  cleanupToken: text("cleanup_token"),
  cleanupClaimedAt: text("cleanup_claimed_at"),
  uploadToken: text("upload_token"),
  uploadLeaseExpiresAt: text("upload_lease_expires_at"),
  folderId: text("folder_id"),
});

export const plaidItems = sqliteTable("plaid_items", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  plaidItemId: text("plaid_item_id").notNull(),
  accessTokenCiphertext: text("access_token_ciphertext").notNull(),
  accessTokenIv: text("access_token_iv").notNull(),
  tokenVersion: integer("token_version").default(1).notNull(),
  institutionId: text("institution_id"),
  institutionName: text("institution_name"),
  cursor: text(),
  status: text().default("active").notNull(),
  errorCode: text("error_code"),
  lastSyncedAt: text("last_synced_at"),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  disconnectedAt: text("disconnected_at"),
});

export const plaidAccounts = sqliteTable("plaid_accounts", {
  id: text().primaryKey(),
  plaidAccountId: text("plaid_account_id").notNull(),
  organizationId: text("organization_id").notNull(),
  plaidItemRecordId: text("plaid_item_record_id").notNull(),
  name: text().notNull(),
  officialName: text("official_name"),
  mask: text(),
  type: text().notNull(),
  subtype: text(),
  currentBalance: real("current_balance"),
  availableBalance: real("available_balance"),
  currencyCode: text("currency_code"),
  updatedAt: text("updated_at").notNull(),
});

export const plaidTransactions = sqliteTable("plaid_transactions", {
  id: text().primaryKey(),
  plaidTransactionId: text("plaid_transaction_id").notNull(),
  organizationId: text("organization_id").notNull(),
  plaidItemRecordId: text("plaid_item_record_id").notNull(),
  accountRecordId: text("account_record_id").notNull(),
  name: text().notNull(),
  merchantName: text("merchant_name"),
  amount: real().notNull(),
  currencyCode: text("currency_code"),
  transactionDate: text("transaction_date").notNull(),
  authorizedDate: text("authorized_date"),
  categoryPrimary: text("category_primary"),
  categoryDetailed: text("category_detailed"),
  paymentChannel: text("payment_channel"),
  pending: integer().notNull(),
  updatedAt: text("updated_at").notNull(),
  pendingTransactionId: text("pending_transaction_id"),
  sourceStatus: text("source_status").default("active").notNull(),
});

export const financeTransactionAnnotations = sqliteTable(
  "finance_transaction_annotations",
  {
    transactionId: text("transaction_id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    note: text().default("").notNull(),
    categoryOverride: text("category_override"),
    labels: text().default("[]").notNull(),
    reviewed: integer().default(0).notNull(),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    expenseCategoryId: text("expense_category_id"),
  },
);

export const team = sqliteTable("team", {
  id: text().primaryKey(),
  name: text().notNull(),
  organizationId: text().notNull(),
  memberCount: integer().default(0).notNull(),
  createdAt: date().notNull(),
  updatedAt: date(),
});

export const teamMember = sqliteTable("teamMember", {
  id: text().primaryKey(),
  teamId: text().notNull(),
  userId: text().notNull(),
  membershipKey: text(),
  createdAt: date(),
});

export const organizationGroupCapability = sqliteTable(
  "organization_group_capability",
  {
    organizationId: text("organization_id").notNull(),
    teamId: text("team_id").notNull(),
    capability: text().notNull(),
  },
  (table) => [primaryKey({ columns: [table.teamId, table.capability] })],
);

export const inboundEmails = sqliteTable("inbound_emails", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  messageId: text("message_id"),
  envelopeFrom: text("envelope_from").notNull(),
  envelopeTo: text("envelope_to").notNull(),
  subject: text(),
  rawObjectKey: text("raw_object_key").notNull(),
  rawSize: integer("raw_size").notNull(),
  receivedAt: text("received_at").notNull(),
  deletedAt: text("deleted_at"),
  deletedByUserId: text("deleted_by_user_id"),
});

export const inboundEmailAttachments = sqliteTable(
  "inbound_email_attachments",
  {
    id: text().primaryKey(),
    emailId: text("email_id").notNull(),
    objectKey: text("object_key").notNull(),
    filename: text().notNull(),
    contentType: text("content_type").notNull(),
    size: integer().notNull(),
    disposition: text(),
    contentId: text("content_id"),
    createdAt: text("created_at").notNull(),
  },
);

export const businesses = sqliteTable("businesses", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text().notNull(),
  ein: text(),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  incorporationDate: text("incorporation_date"),
  streetAddress: text("street_address"),
  city: text(),
  state: text(),
  zip: text(),
});

export const twoFactor = sqliteTable("twoFactor", {
  id: text().primaryKey(),
  secret: text().notNull(),
  backupCodes: text().notNull(),
  userId: text().notNull(),
  verified: integer().default(1).notNull(),
  failedVerificationCount: integer().default(0).notNull(),
  lockedUntil: date(),
});

export const auditTemplateFamilies = sqliteTable("audit_template_families", {
  id: text().primaryKey(),
  scope: text().notNull(),
  organizationId: text("organization_id"),
  currentVersion: integer("current_version").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const auditTemplateVersions = sqliteTable("audit_template_versions", {
  id: text().primaryKey(),
  templateId: text("template_id").notNull(),
  version: integer().notNull(),
  name: text().notNull(),
  description: text().notNull(),
  definition: text().notNull(),
  status: text().default("draft").notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: text("created_at").notNull(),
});

export const auditIssueImages = sqliteTable("audit_issue_images", {
  id: text().primaryKey(),
  issueId: text("issue_id").notNull(),
  objectId: text("object_id").notNull(),
  uploadedBy: text("uploaded_by").notNull(),
  slot: integer().notNull(),
  createdAt: text("created_at").notNull(),
});

export const deletedObjectCleanup = sqliteTable("deleted_object_cleanup", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  objectKey: text("object_key").notNull(),
  deletedAt: text("deleted_at").notNull(),
  cleanupToken: text("cleanup_token"),
  cleanupClaimedAt: text("cleanup_claimed_at"),
});

export const organizationBilling = sqliteTable("organization_billing", {
  organizationId: text("organization_id").primaryKey(),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  stripeSubscriptionItemId: text("stripe_subscription_item_id"),
  stripePriceId: text("stripe_price_id"),
  stripeStatus: text("stripe_status"),
  seatQuantity: integer("seat_quantity").default(1).notNull(),
  cancelAtPeriodEnd: integer("cancel_at_period_end").default(0).notNull(),
  currentPeriodEnd: text("current_period_end"),
  stripeEventCreated: integer("stripe_event_created").default(0).notNull(),
  checkoutClaimId: text("checkout_claim_id"),
  checkoutClaimCustomerId: text("checkout_claim_customer_id"),
  checkoutClaimPriceId: text("checkout_claim_price_id"),
  checkoutClaimQuantity: integer("checkout_claim_quantity"),
  checkoutClaimExpiresAt: integer("checkout_claim_expires_at"),
  checkoutDisabledAt: text("checkout_disabled_at"),
  checkoutDisabledExpiresAt: integer("checkout_disabled_expires_at"),
  pendingCheckoutSessionId: text("pending_checkout_session_id"),
  pendingCheckoutUrl: text("pending_checkout_url"),
  pendingCheckoutExpiresAt: integer("pending_checkout_expires_at"),
  pendingCheckoutRetryAt: integer("pending_checkout_retry_at"),
  lastReconciledAt: text("last_reconciled_at"),
  updatedAt: text("updated_at").notNull(),
});

export const stripeSubscriptionSyncLocks = sqliteTable(
  "stripe_subscription_sync_locks",
  {
    subscriptionId: text("subscription_id").primaryKey(),
    claimId: text("claim_id").notNull(),
    claimExpiresAt: integer("claim_expires_at").notNull(),
  },
);

export const stripeWebhookEvents = sqliteTable("stripe_webhook_events", {
  id: text().primaryKey(),
  eventType: text("event_type").notNull(),
  stripeCreated: integer("stripe_created").notNull(),
  receivedAt: text("received_at").notNull(),
  processedAt: text("processed_at"),
});

export const financeExpenseCategories = sqliteTable(
  "finance_expense_categories",
  {
    id: text().primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
);

export const libraryFolders = sqliteTable("library_folders", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  name: text().notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const equipment = sqliteTable("equipment", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  type: text().notNull(),
  make: text().notNull(),
  model: text().notNull(),
  serialNumber: text("serial_number"),
  purchaseDate: text("purchase_date"),
  assignedUserId: text("assigned_user_id"),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const inboundEmailLinks = sqliteTable("inbound_email_links", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  emailId: text("email_id").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  createdBy: text("created_by"),
  createdAt: text("created_at").notNull(),
});

export const contracts = sqliteTable("contracts", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  title: text().notNull(),
  message: text().default("").notNull(),
  status: text().default("draft").notNull(),
  signingOrder: text("signing_order").default("parallel").notNull(),
  dueDate: text("due_date"),
  reminderIntervalDays: integer("reminder_interval_days"),
  documentObjectKey: text("document_object_key").notNull(),
  documentFilename: text("document_filename").notNull(),
  documentSize: integer("document_size").notNull(),
  documentSha256: text("document_sha256").notNull(),
  documentPageCount: integer("document_page_count").notNull(),
  finalObjectKey: text("final_object_key"),
  finalSha256: text("final_sha256"),
  createdBy: text("created_by"),
  sentBy: text("sent_by"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  sentAt: text("sent_at"),
  completedAt: text("completed_at"),
  voidedAt: text("voided_at"),
  voidReason: text("void_reason"),
  revision: integer().default(0).notNull(),
  resumeAttempts: integer("resume_attempts").default(0).notNull(),
  resumeAttemptedAt: text("resume_attempted_at"),
});

export const contractRecipients = sqliteTable("contract_recipients", {
  id: text().primaryKey(),
  contractId: text("contract_id").notNull(),
  organizationId: text("organization_id").notNull(),
  name: text().notNull(),
  email: text().notNull(),
  routingOrder: integer("routing_order").default(1).notNull(),
  status: text().default("pending").notNull(),
  tokenNonce: text("token_nonce"),
  tokenHash: text("token_hash"),
  notifiedAt: text("notified_at"),
  lastRemindedAt: text("last_reminded_at"),
  viewedAt: text("viewed_at"),
  signedAt: text("signed_at"),
  signedIp: text("signed_ip"),
  signedUserAgent: text("signed_user_agent"),
  signatureImage: text("signature_image"),
  initialsImage: text("initials_image"),
  declinedAt: text("declined_at"),
  declineReason: text("decline_reason"),
  createdAt: text("created_at").notNull(),
});

export const contractFields = sqliteTable("contract_fields", {
  id: text().primaryKey(),
  contractId: text("contract_id").notNull(),
  recipientId: text("recipient_id").notNull(),
  type: text().notNull(),
  page: integer().notNull(),
  x: real().notNull(),
  y: real().notNull(),
  width: real().notNull(),
  height: real().notNull(),
  required: integer().default(1).notNull(),
  label: text(),
  value: text(),
});

export const contractEvents = sqliteTable("contract_events", {
  id: text().primaryKey(),
  contractId: text("contract_id").notNull(),
  recipientId: text("recipient_id"),
  actorUserId: text("actor_user_id"),
  type: text().notNull(),
  detail: text(),
  ip: text(),
  userAgent: text("user_agent"),
  createdAt: text("created_at").notNull(),
});

export const employeeRequirements = sqliteTable("employee_requirements", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  invitationId: text("invitation_id"),
  memberId: text("member_id"),
  targetEmail: text("target_email").notNull(),
  assignedUserId: text("assigned_user_id"),
  kind: text().notNull(),
  title: text().notNull(),
  dueDate: text("due_date").notNull(),
  status: text().default("pending").notNull(),
  documentKey: text("document_key"),
  documentFilename: text("document_filename"),
  documentSize: integer("document_size"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
  checkrCandidateId: text("checkr_candidate_id"),
  checkrInvitationId: text("checkr_invitation_id"),
  checkrReportId: text("checkr_report_id"),
  checkrResult: text("checkr_result"),
  checkrInvitationStatus: text("checkr_invitation_status"),
  documentRevision: integer("document_revision").default(0).notNull(),
  checkrStartingAt: text("checkr_starting_at"),
  checkrStartNonce: text("checkr_start_nonce"),
  checkrStartNonceAt: text("checkr_start_nonce_at"),
  checkrAttempt: integer("checkr_attempt").default(0).notNull(),
  checkrRefreshRevision: integer("checkr_refresh_revision")
    .default(0)
    .notNull(),
  checkrStartPackage: text("checkr_start_package"),
});
