import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readdirSync } from "node:fs";

type D1Method = "all" | "first" | "raw" | "run" | "batch";

interface TestD1Hooks {
  /**
   * Runs before each statement executes against SQLite. It may throw to
   * simulate a D1 failure or mutate the database to simulate a race.
   */
  beforeExecute?: (
    query: string,
    values: readonly SQLQueryBindings[],
    method: D1Method,
  ) => void;
  /** Runs after a statement executed successfully. */
  afterExecute?: (
    query: string,
    values: readonly SQLQueryBindings[],
    method: D1Method,
  ) => void;
}

const migrationsDirectory = `${import.meta.dir}/../migrations`;

/** The sorted migration filenames, as Wrangler applies them. */
function migrationFilenames() {
  return readdirSync(migrationsDirectory)
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
}

/**
 * Applies migrations to a SQLite database. With `through`, applies only the
 * migrations up to and including that filename.
 */
export async function applyMigrations(
  database: Database,
  options: { through?: string } = {},
) {
  for (const filename of migrationFilenames()) {
    database.exec(await Bun.file(`${migrationsDirectory}/${filename}`).text());
    if (filename === options.through) return;
  }
}

/** An in-memory database with every migration applied, as D1 runs it. */
export async function migratedDatabase() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  await applyMigrations(database);
  return database;
}

// D1 rejects statements with more bound parameters than this, although
// SQLite itself allows far more.
const maxBoundParameters = 100;

const writePattern = /^\s*(?:insert|update|delete|replace)\b/i;

/**
 * Adapts a Bun SQLite database to the D1 binding API with D1's semantics:
 * `bind` returns a new statement, results use D1's shapes, `first` returns
 * `null` for no row, and `batch` runs its statements in one transaction.
 */
export function createTestD1(
  database: Database,
  hooks: TestD1Hooks = {},
): D1Database {
  const execute = <T>(
    query: string,
    values: SQLQueryBindings[],
    method: D1Method,
    operation: () => T,
  ) => {
    hooks.beforeExecute?.(query, values, method);
    const result = operation();
    hooks.afterExecute?.(query, values, method);
    return result;
  };

  const allResult = (
    query: string,
    values: SQLQueryBindings[],
    method: D1Method,
  ) =>
    execute(query, values, method, () => {
      const statement = database.query(query);
      if (statement.columnNames.length === 0) {
        const result = statement.run(...values);
        return d1Result([], result.changes, Number(result.lastInsertRowid));
      }
      const results = statement.all(...values) as Record<string, unknown>[];
      const changes = writePattern.test(query) ? lastChanges(database) : 0;
      return d1Result(results, changes, 0);
    });

  const statementFor = (
    query: string,
    values: SQLQueryBindings[],
  ): D1PreparedStatement => {
    const statement = {
      all: async () => allResult(query, values, "all"),
      bind: (...nextValues: unknown[]) => {
        for (const value of nextValues) {
          if (value === undefined) {
            throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported");
          }
        }
        if (nextValues.length > maxBoundParameters) {
          throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
        }
        return statementFor(query, nextValues as SQLQueryBindings[]);
      },
      first: async (column?: string) => {
        const row = execute(query, values, "first", () =>
          database.query(query).get(...values),
        ) as Record<string, unknown> | null;
        if (row === null) return null;
        return column === undefined ? row : (row[column] ?? null);
      },
      raw: async (options?: { columnNames?: boolean }) =>
        execute(query, values, "raw", () => {
          const prepared = database.query(query);
          const rows = prepared.values(...values) as unknown[][];
          return options?.columnNames ? [prepared.columnNames, ...rows] : rows;
        }),
      run: async () => allResult(query, values, "run"),
      // Internal: lets batch execute the statement synchronously.
      [batchQuery]: { query, values },
    };
    return statement as unknown as D1PreparedStatement;
  };

  return {
    batch: async (statements: D1PreparedStatement[]) => {
      database.exec("BEGIN");
      try {
        const results = statements.map((statement) => {
          const { query, values } = (
            statement as unknown as Record<
              typeof batchQuery,
              { query: string; values: SQLQueryBindings[] }
            >
          )[batchQuery];
          return allResult(query, values, "batch");
        });
        database.exec("COMMIT");
        return results;
      } catch (cause) {
        database.exec("ROLLBACK");
        throw cause;
      }
    },
    exec: async (query: string) => {
      database.exec(query);
      return { count: 1, duration: 0 };
    },
    prepare: (query: string) => statementFor(query, []),
  } as unknown as D1Database;
}

const batchQuery = Symbol("batchQuery");

function lastChanges(database: Database) {
  const row = database.query("SELECT changes() AS changes").get() as {
    changes: number;
  };
  return row.changes;
}

function d1Result(
  results: Record<string, unknown>[],
  changes: number,
  lastRowId: number,
) {
  return {
    meta: { changed_db: changes > 0, changes, last_row_id: lastRowId },
    results,
    success: true,
  };
}
