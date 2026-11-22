import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "csv/sync";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { InspectionRecord } from "../src/domain/inspection-record";

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

function run(name: string) {
  const result = spawnSync(process.execPath, [
    "--import", loader, cli, "--config", `config/${name}.json`,
  ], { cwd: directory, encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

function report(name: string) {
  const result = run(name);
  expect(result.status, result.stderr).toBe(0);
  return parse(readFileSync(path.join(directory, "output", `${name}.csv`)));
}

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
