import { describe, expect, it } from "bun:test";
import { getTableConfig, type SQLiteTable } from "drizzle-orm/sqlite-core";
import * as schema from "./schema";
import { migratedDatabase } from "./testDatabase";

interface ColumnInfo {
  dflt_value: string | null;
  name: string;
  notnull: number;
  pk: number;
  type: string;
}

function describeColumns(columns: ColumnInfo[]) {
  return columns
    .map((column) => ({
      default: column.dflt_value,
      name: column.name,
      notNull: column.notnull === 1 || column.pk > 0,
      primaryKey: column.pk > 0,
      type: column.type.toLowerCase(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function sqlLiteral(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error(`Unsupported schema default ${String(value)}`);
}

describe("schema", () => {
  it("mirrors every table, column, and default the migrations create", async () => {
    const database = await migratedDatabase();
    const migratedTables = (
      database
        .query(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((table) => table.name);

    const schemaTables = new Map(
      Object.values(schema).map((table) => {
        const config = getTableConfig(table as SQLiteTable);
        return [config.name, config] as const;
      }),
    );
    expect([...schemaTables.keys()].sort()).toEqual(migratedTables);

    for (const tableName of migratedTables) {
      const config = schemaTables.get(tableName);
      if (!config) throw new Error(`Missing schema table ${tableName}`);
      const compositeKey = new Set(
        config.primaryKeys.flatMap((key) =>
          key.columns.map((column) => column.name),
        ),
      );
      const expected = describeColumns(
        database
          .query(`SELECT * FROM pragma_table_info(?)`)
          .all(tableName) as ColumnInfo[],
      );
      const actual = describeColumns(
        config.columns.map((column) => ({
          // Drizzle writes a column's schema default, or NULL, when an insert
          // omits it, so every SQL default must be mirrored exactly.
          dflt_value: sqlLiteral(column.default),
          name: column.name,
          notnull: column.notNull ? 1 : 0,
          pk: column.primary || compositeKey.has(column.name) ? 1 : 0,
          type: column.getSQLType(),
        })),
      );
      expect({ table: tableName, columns: actual }).toEqual({
        table: tableName,
        columns: expected,
      });
    }
  });
});
