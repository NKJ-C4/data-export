import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const defaultDatabasePath = "data/export.sqlite";

export function openExportDatabase(file = defaultDatabasePath): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS export_runs (
        run_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'running', 'completed', 'failed')),
        config_snapshot TEXT NOT NULL CHECK (json_valid(config_snapshot)),
        source_boundary INTEGER NOT NULL CHECK (source_boundary >= 0),
        last_processed_sequence INTEGER NOT NULL DEFAULT 0
          CHECK (last_processed_sequence BETWEEN 0 AND source_boundary),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS inspections (
        sequence INTEGER PRIMARY KEY,
        record_json TEXT NOT NULL CHECK (json_valid(record_json))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS export_rows (
        run_id TEXT NOT NULL REFERENCES export_runs(run_id),
        sequence INTEGER NOT NULL,
        csv_line TEXT NOT NULL,
        PRIMARY KEY (run_id, sequence)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS hourly_reports (
        tenant_id TEXT NOT NULL,
        config_name TEXT NOT NULL,
        window_start TEXT NOT NULL,
        run_id TEXT NOT NULL UNIQUE REFERENCES export_runs(run_id),
        output_path TEXT NOT NULL UNIQUE,
        PRIMARY KEY (tenant_id, config_name, window_start)
      ) STRICT;
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

// A synchronous callback keeps the database transaction inside this call.
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
