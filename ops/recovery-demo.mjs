import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "csv-recovery-"));
const output = join(dir, "output/failed-inspections.csv");
const baseline = join(dir, "baseline.csv");
const start = ["--config", "config/failed-inspections.json"];

function invoke(args, expectedExit = 0) {
  const child = spawnSync(process.execPath, ["--import", loader, cli, ...args], {
    cwd: dir, stdio: "inherit",
  });
  if (child.error) throw child.error;
  assert.equal(child.status, expectedExit, "Unexpected CLI exit");
}

try {
  for (const folder of ["config", "sample-data"]) {
    cpSync(new URL(`../${folder}/`, import.meta.url), join(dir, folder), { recursive: true });
  }
  console.log("1. Save an uninterrupted CSV for comparison.");
  invoke(start);
  renameSync(output, baseline);

  const db = new DatabaseSync(join(dir, "data/export.sqlite"));
  try {
    db.exec(`CREATE TRIGGER fail_before_checkpoint BEFORE UPDATE OF last_processed_sequence ON export_runs
      WHEN NEW.last_processed_sequence = 4 AND EXISTS (
        SELECT 1 FROM export_rows WHERE run_id = NEW.run_id AND sequence = 4
      )
      BEGIN SELECT RAISE(ABORT, 'Demo interruption: row 4 staged; checkpoint 4 blocked'); END`);
    console.log("2. Stage row 4 and force the checkpoint update to fail.");
    invoke(start, 1);

    const run = db.prepare("SELECT * FROM export_runs WHERE status = 'failed'").get();
    assert.ok(run, "Expected a failed run");
    const sequences = db.prepare("SELECT sequence FROM export_rows WHERE run_id = ? ORDER BY sequence").all(run.run_id);
    assert.equal(run.last_processed_sequence, 2);
    assert.deepEqual(sequences.map(row => row.sequence), [2]);
    assert.equal(existsSync(output), false);
    console.log("After rollback: checkpoint 2, only row 2 staged, no partial CSV published.");

    db.exec("DROP TRIGGER fail_before_checkpoint");
    console.log("3. Resume the same run in a fresh CLI process.");
    invoke(["--resume", run.run_id]);
    assert.deepEqual(readFileSync(output), readFileSync(baseline));
    console.log("Recovered CSV matches the uninterrupted CSV byte for byte.");
  } finally {
    db.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
