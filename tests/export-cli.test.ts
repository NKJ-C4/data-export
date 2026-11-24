import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "csv/sync";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { InspectionRecord } from "../src/domain/inspection-record";
import { reportingHour } from "../src/export/hourly";

const cli = path.resolve("src/cli.ts");
const loader = pathToFileURL(require.resolve("tsx")).href;
let directory: string;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "inspection-export-"));
  for (const folder of ["config", "sample-data"]) {
    cpSync(folder, path.join(directory, folder), { recursive: true });
  }
});

afterEach(() => rmSync(directory, { recursive: true, force: true }));

function invoke(...args: string[]) {
  const result = spawnSync(process.execPath, [
    "--import", loader, cli, ...args,
  ], { cwd: directory, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function run(name: string) {
  return invoke("--config", `config/${name}.json`);
}

function report(name: string) {
  const result = run(name);
  expect(result.status, result.stderr).toBe(0);
  return parse(readFileSync(path.join(directory, "output", `${name}.csv`)));
}

function storedRuns() {
  const db = new DatabaseSync(path.join(directory, "data/export.sqlite"), { readOnly: true });
  try {
    return db.prepare("SELECT * FROM export_runs ORDER BY rowid").all();
  } finally {
    db.close();
  }
}

it("uses the previous complete UTC hour, including across midnight", () => {
  const now = Date.parse("2026-12-01T00:02:00Z");
  expect(reportingHour(undefined, now)).toBe("2026-11-30T23:00:00.000Z");
  expect(() => reportingHour("2026-11-30T23:05:00Z", now)).toThrow();
  expect(() => reportingHour("2026-12-01T00:00:00Z", now)).toThrow();
});

it("publishes distinct hourly files, includes the start only, and reuses a finished run", () => {
  const file = path.join(directory, "sample-data/inspection-records.json");
  const records: InspectionRecord[] = JSON.parse(readFileSync(file, "utf8"));
  const failed = records.find(record => record.result === "FAIL")!;
  writeFileSync(file, JSON.stringify(["07:59:59", "08:00:00", "08:59:59", "09:00:00"].map(time => ({
    ...failed, id: time, inspectedAt: `2026-11-21T${time}Z`,
  }))));
  const tick = (hour: string) => invoke("--config", "config/failed-inspections.json", "--hourly",
    "--hour", `2026-11-21T${hour}:00:00Z`);
  expect(tick("08").status).toBe(0);
  expect(tick("08").stdout).toContain("already completed");
  expect(tick("09").status).toBe(0);
  const ids = (hour: string) => parse(readFileSync(path.join(directory,
    `output/failed-inspections-2026-11-21T${hour}Z.csv`))).slice(1).map((row: string[]) => row[0]);
  expect(ids("08")).toEqual(["08:00:00", "08:59:59"]);
  expect(ids("09")).toEqual(["09:00:00"]);
  expect(storedRuns()).toHaveLength(2);
});

it("retries a failed hourly publication with its saved path and settings", () => {
  const configPath = "config/failed-inspections.json";
  const tick = () => invoke("--config", configPath, "--hourly", "--hour", "2026-11-21T08:00:00Z");
  const target = path.join(directory, "output/failed-inspections-2026-11-21T08Z.csv");
  mkdirSync(target, { recursive: true });
  expect(tick().status).toBe(1);
  rmSync(target, { recursive: true });
  const config = JSON.parse(readFileSync(path.join(directory, configPath), "utf8"));
  config.destination.path = "output/edited.csv";
  config.filters.results = ["PASS"];
  writeFileSync(path.join(directory, configPath), JSON.stringify(config));
  expect(tick().status).toBe(0);
  expect(parse(readFileSync(target)).slice(1).map((row: string[]) => row[1])).toEqual(Array(4).fill("FAIL"));
  expect(storedRuns()).toHaveLength(1);
});

it("keeps each run's original settings and boundary when the next export starts", () => {
  const name = "failed-inspections";
  const configPath = path.join(directory, "config", `${name}.json`);
  const original = JSON.parse(readFileSync(configPath, "utf8"));
  const first = run(name);
  expect(first.status, first.stderr).toBe(0);

  const sourcePath = path.join(directory, "sample-data/inspection-records.json");
  const records: InspectionRecord[] = JSON.parse(readFileSync(sourcePath, "utf8"));
  records.push({ ...records[0], id: "later" });
  writeFileSync(sourcePath, JSON.stringify(records));
  const edited = { ...original, filters: { results: ["PASS"] } };
  writeFileSync(configPath, JSON.stringify(edited));
  const second = run(name);
  expect(second.status, second.stderr).toBe(0);

  const runs = storedRuns();
  expect(runs).toHaveLength(2);
  const [a, b] = runs;
  expect(first.stdout).toContain(`Run ID: ${a.run_id}`);
  expect(second.stdout).toContain(`Run ID: ${b.run_id}`);
  expect(a.run_id).not.toBe(b.run_id);
  expect(a).toMatchObject({ status: "completed", source_boundary: 8, last_processed_sequence: 8 });
  expect(b).toMatchObject({ status: "completed", source_boundary: 9, last_processed_sequence: 9 });
  expect(JSON.parse(String(a.config_snapshot))).toEqual(original);
  expect(JSON.parse(String(b.config_snapshot))).toEqual(edited);
});

it("retains the run ID and a failed status if the CSV cannot be published", () => {
  mkdirSync(path.join(directory, "output/failed-inspections.csv"), { recursive: true });
  const result = run("failed-inspections");
  expect(result.status).toBe(1);
  const [row] = storedRuns();
  expect(result.stdout).toContain(`Run ID: ${row.run_id}`);
  expect(row).toMatchObject({ status: "failed", last_processed_sequence: 8, completed_at: null });
  rmSync(path.join(directory, "output/failed-inspections.csv"), { recursive: true });
  expect(invoke("--resume", String(row.run_id)).status).toBe(0);
  expect(storedRuns()).toHaveLength(1);
  expect(storedRuns()[0].status).toBe("completed");
});

it("rolls back a partial batch and resumes with the original settings and source boundary", () => {
  const name = "failed-inspections";
  const output = path.join(directory, "output", `${name}.csv`);
  expect(run(name).status).toBe(0);
  const expected = readFileSync(output);
  rmSync(output);
  const db = new DatabaseSync(path.join(directory, "data/export.sqlite"));
  try {
    db.exec(`CREATE TRIGGER interrupt_batch BEFORE UPDATE OF last_processed_sequence ON export_runs
             WHEN NEW.last_processed_sequence = 4
               AND EXISTS (SELECT 1 FROM export_rows WHERE run_id = NEW.run_id AND sequence = 4)
             BEGIN SELECT RAISE(ABORT, 'interrupted before checkpoint'); END`);
    const failed = run(name);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("interrupted before checkpoint");
    const [, interrupted] = storedRuns();
    const id = String(interrupted.run_id);
    expect(interrupted).toMatchObject({ status: "failed", last_processed_sequence: 2, source_boundary: 8 });
    expect(db.prepare("SELECT sequence FROM export_rows WHERE run_id = ?").all(id)).toEqual([{ sequence: 2 }]);
    expect(existsSync(output)).toBe(false);
    db.exec("DROP TRIGGER interrupt_batch");

    const source = path.join(directory, "sample-data/inspection-records.json");
    const records: InspectionRecord[] = JSON.parse(readFileSync(source, "utf8"));
    records.push({ ...records[1], id: "later-failure" });
    writeFileSync(source, JSON.stringify(records));
    expect(run("high-confidence-inspections").status).toBe(0);
    rmSync(source);
    rmSync(path.join(directory, "config", `${name}.json`));

    const resumed = invoke("--resume", id);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(readFileSync(output)).toEqual(expected);
    expect(storedRuns()[1]).toMatchObject({ run_id: id, status: "completed", last_processed_sequence: 8 });
    expect(invoke("--resume", id).stdout).toContain("already completed");
    expect(storedRuns()).toHaveLength(3);
  } finally {
    db.close();
  }
});

it("advances across fully filtered batches and publishes a header-only CSV", () => {
  const file = path.join(directory, "config/failed-inspections.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.filters.minimumConfidence = 1;
  writeFileSync(file, JSON.stringify(config));
  expect(report("failed-inspections")).toEqual([["Inspection ID", "Result", "Defect Type", "Inspected At"]]);
  expect(storedRuns()[0]).toMatchObject({ status: "completed", last_processed_sequence: 8 });
});

it("exports the four failed inspections with the requested columns and a blank for a missing defect", () => {
  expect(report("failed-inspections")).toEqual([
    ["Inspection ID", "Result", "Defect Type", "Inspected At"],
    ["inspection-002", "FAIL", "SURFACE_SCRATCH", "2026-11-21T08:02:45.000Z"],
    ["inspection-004", "FAIL", "MISSING_COMPONENT", "2026-11-21T08:07:31.000Z"],
    ["inspection-006", "FAIL", "INCORRECT_ALIGNMENT", "2026-11-21T08:11:52.000Z"],
    ["inspection-008", "FAIL", "", "2026-11-21T08:17:09.000Z"],
  ]);
});

it("exports both passing and failing high-confidence results with percentage and line formatting", () => {
  expect(report("high-confidence-inspections")).toEqual([
    ["Inspection ID", "Result", "Confidence", "Production Line"],
    ["inspection-001", "PASS", "98%", "LINE-A"],
    ["inspection-002", "FAIL", "94%", "LINE-A"],
    ["inspection-004", "FAIL", "99%", "LINE-A"],
    ["inspection-005", "PASS", "88%", "LINE-B"],
    ["inspection-007", "PASS", "96%", "LINE-B"],
  ]);
});

it("includes a matching record at the threshold and excludes each out-of-scope copy", () => {
  const file = path.join(directory, "sample-data/inspection-records.json");
  const samples: InspectionRecord[] = JSON.parse(readFileSync(file, "utf8"));
  const matching = { ...samples[0], id: "included", confidence: 0.8 };
  writeFileSync(file, JSON.stringify([
    matching,
    { ...matching, id: "other-tenant", tenantId: "another-tenant" },
    { ...matching, id: "other-workspace", workspaceId: "another-workspace" },
    { ...matching, id: "other-session", sessionId: "another-session" },
  ]));
  expect(report("high-confidence-inspections").slice(1)).toEqual([
    ["included", "PASS", "80%", "LINE-A"],
  ]);
});

it("reports an invalid filter and creates no CSV", () => {
  const file = path.join(directory, "config/high-confidence-inspections.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.filters.minimumConfidence = 1.2;
  writeFileSync(file, JSON.stringify(config));
  const result = run("high-confidence-inspections");
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("filters.minimumConfidence");
  expect(existsSync(path.join(directory, config.destination.path))).toBe(false);
});
