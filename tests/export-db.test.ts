import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openExportDatabase } from "../src/storage/export-db";

it("keeps a run when the database is closed and initialized again", ({ onTestFinished }) => {
  const dir = mkdtempSync(join(tmpdir(), "export-db-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "data", "export.sqlite");
  const snapshot = JSON.stringify({ name: "failed-inspections" });

  const writer = openExportDatabase(file);
  try {
    writer.prepare(`INSERT INTO export_runs (run_id, config_snapshot, source_boundary)
                    VALUES (?, ?, ?)`).run("test-run", snapshot, 8);
  } finally {
    writer.close();
  }

  const reader = openExportDatabase(file);
  try {
    expect(reader.prepare("SELECT * FROM export_runs WHERE run_id = ?").get("test-run"))
      .toMatchObject({
        config_snapshot: snapshot, source_boundary: 8,
        last_processed_sequence: 0, status: "pending", completed_at: null,
      });
  } finally {
    reader.close();
  }
});
