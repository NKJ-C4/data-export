import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const defaultDatabasePath = "data/export.sqlite";

export function openExportDatabase(file = defaultDatabasePath): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(`
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
    `);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
