export interface Bindings {
  CORS_ORIGIN: string;
  DB: D1Database;
  STORAGE: R2Bucket;
}

interface StoredObject {
  id: string;
  objectKey: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface StoredObjectRow {
  id: string;
  object_key: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: string;
}

export function toStoredObject(row: StoredObjectRow): StoredObject {
  return {
    id: row.id,
    objectKey: row.object_key,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}
