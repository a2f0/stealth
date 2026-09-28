import { type SQL, sql } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

export type Db = DrizzleD1Database;

const clients = new WeakMap<D1Database, Db>();

/** Returns the Drizzle client for a D1 binding, reusing one per binding. */
export function getDb(database: D1Database): Db {
  let client = clients.get(database);
  if (!client) {
    client = drizzle(database);
    clients.set(database, client);
  }
  return client;
}

/** The value an upsert proposed for a column, for `onConflictDoUpdate`. */
export function excluded(column: SQLiteColumn): SQL {
  return sql`excluded.${sql.identifier(column.name)}`;
}

/**
 * Unqualified column names for the column list of a whole-statement write;
 * SQLite rejects table-qualified names there.
 */
export function columnNames(...columns: SQLiteColumn[]): SQL {
  return sql.join(
    columns.map((column) => sql.identifier(column.name)),
    sql`, `,
  );
}
