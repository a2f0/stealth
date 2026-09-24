export interface Bindings {
  AUTH_EMAIL_FROM: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  CORS_ORIGIN: string;
  CHECKR_API_KEY?: string;
  CHECKR_ENV?: "staging" | "production";
  CHECKR_BACKGROUND_PACKAGE?: string;
  CHECKR_CREDIT_PACKAGE?: string;
  DB: D1Database;
  EMAIL: SendEmail;
  INBOUND_EMAIL_DOMAIN: string;
  IMAGES: ImagesBinding;
  PLAID_CLIENT_ID?: string;
  PLAID_ENV?: "development" | "production" | "sandbox";
  PLAID_REDIRECT_URI?: string;
  PLAID_SECRET?: string;
  PLAID_TOKEN_ENCRYPTION_KEY?: string;
  STRIPE_PRO_PRICE_ID?: string;
  STRIPE_PRO_LEGACY_PRICE_IDS?: string;
  STRIPE_PORTAL_CONFIGURATION_ID?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STORAGE: R2Bucket;
}

interface StoredObject {
  folderId: string | null;
  id: string;
  objectKey: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface StoredObjectRow {
  folder_id: string | null;
  id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: string;
}

export function toStoredObject(row: StoredObjectRow): StoredObject {
  return {
    folderId: row.folder_id,
    id: row.id,
    objectKey: row.object_key,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}
