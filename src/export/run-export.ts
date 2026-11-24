import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { renameSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { stringify } from "csv/sync";
import type { InspectionRecord } from "../domain/inspection-record";
import { validateExportConfig, type ExportConfig } from "./export-config";
import { openExportDatabase, transaction } from "../storage/export-db";
import { importInspections } from "../storage/inspection-source";
import { hourMs, hourlyRun } from "./hourly";

function matches(record: InspectionRecord, config: ExportConfig): boolean {
  const { results, minimumConfidence = 0 } = config.filters;
  return record.tenantId === config.tenantId
    && record.workspaceId === config.workspaceId
    && (!config.sessionId || record.sessionId === config.sessionId)
    && (!results || results.includes(record.result))
    && record.confidence >= minimumConfidence;
}

function cell(record: InspectionRecord, column: ExportConfig["columns"][number]) {
  const { source, transform } = column;
  let value: string | number | undefined;
  switch (source) {
    case "metadata.productionLine": value = record.metadata.productionLine; break;
    case "metadata.operator": value = record.metadata.operator; break;
    default: value = record[source];
  }
  if (value === undefined) return "";
  switch (transform) {
    case "uppercase": return String(value).toUpperCase();
    case "percentage": return Number(value).toLocaleString("en-US", {
      style: "percent", maximumFractionDigits: 2,
    });
    case "iso-date": return new Date(value).toISOString();
    default: return value;
  }
}

async function outputDirectory(destination: string) {
  // The config validator restricts this path to output/. Reject directory links
  // as well, so a local link can't redirect the report outside that folder.
  let parent = await realpath(".");
  for (const part of path.dirname(destination).split(path.sep)) {
    parent = path.join(parent, part);
    await mkdir(parent, { recursive: true });
    if (await realpath(parent) !== parent) {
      throw new Error("Output directory must not contain symbolic links");
    }
  }
  return parent;
}

function stageBatches(db: DatabaseSync, runId: string, config: ExportConfig, boundary: number, hourStart?: number) {
  const progress = db.prepare("SELECT last_processed_sequence FROM export_runs WHERE run_id = ?");
  const batch = db.prepare(`SELECT sequence, record_json FROM inspections
    WHERE sequence > ? AND sequence <= ? ORDER BY sequence LIMIT 2`);
  const stage = db.prepare("INSERT INTO export_rows (run_id, sequence, csv_line) VALUES (?, ?, ?)");
  const advance = db.prepare("UPDATE export_runs SET last_processed_sequence = ? WHERE run_id = ?");

  let finished = false;
  while (!finished) {
    finished = transaction(db, () => {
      // Read under the write lock so two attempts cannot stage the same batch.
      const checkpoint = Number(progress.get(runId)!.last_processed_sequence);
      if (checkpoint === boundary) return true;
      const rows = batch.all(checkpoint, boundary);
      let last = checkpoint;
      for (const row of rows) {
        last++;
        if (row.sequence !== last) throw new Error(`Missing source position ${last}`);
        const record: InspectionRecord = JSON.parse(String(row.record_json));
        if (matches(record, config)) {
          if (hourStart !== undefined) {
            const time = Date.parse(record.inspectedAt);
            if (!Number.isFinite(time)) throw new Error(`Invalid inspectedAt on ${record.id}`);
            if (time < hourStart || time >= hourStart + hourMs) continue;
          }
          const cells = config.columns.map(column => cell(record, column));
          stage.run(runId, last, stringify([cells], { escape_formulas: true }));
        }
      }
      if (!rows.length) throw new Error(`Missing source position ${checkpoint + 1}`);
      advance.run(last, runId);
      return last === boundary;
    });
  }
}

async function publishReport(db: DatabaseSync, runId: string, config: ExportConfig, output: string) {
  const parent = await outputDirectory(output);
  const temporary = path.join(parent, `.${randomUUID()}.tmp`);
  let exported = 0;
  function* lines() {
    yield stringify([config.columns.map(column => column.header)], { escape_formulas: true });
    const rows = db.prepare("SELECT csv_line FROM export_rows WHERE run_id = ? ORDER BY sequence");
    for (const row of rows.iterate(runId)) {
      exported++;
      yield String(row.csv_line);
    }
  }
  try {
    await writeFile(temporary, lines(), { flag: "wx" });
    transaction(db, () => {
      const mark = db.prepare(`UPDATE export_runs SET status = 'completed', completed_at = CURRENT_TIMESTAMP
                               WHERE run_id = ? AND status <> 'completed'`).run(runId);
      // A rename failure rolls back the status. A crash before COMMIT permits an identical replay.
      if (mark.changes) renameSync(temporary, output);
    });
  } finally {
    await rm(temporary, { force: true });
  }
  return exported;
}

type ExportRequest = { configPath: string; hour?: string } | { runId: string };

export async function runExport(input: string | ExportRequest, onStarted?: (runId: string) => void) {
  const request = typeof input === "string" ? { configPath: input } : input;
  const config = "configPath" in request
    ? validateExportConfig(JSON.parse(await readFile(request.configPath, "utf8")))
    : undefined;
  const db = openExportDatabase();
  try {
    let runId = "runId" in request ? request.runId : randomUUID();
    const scheduled = "hour" in request && request.hour !== undefined;
    if (config && scheduled) {
      runId = await hourlyRun(db, config, request.hour!);
    } else if (config) {
      const boundary = await importInspections(db);
      db.prepare(`INSERT INTO export_runs (run_id, config_snapshot, source_boundary)
                  VALUES (?, ?, ?)`).run(runId, JSON.stringify(config), boundary);
    }
    const run = db.prepare("SELECT * FROM export_runs WHERE run_id = ?").get(runId);
    if (!run) throw new Error(`Unknown export run: ${runId}`);
    const saved = validateExportConfig(JSON.parse(String(run.config_snapshot)));
    const boundary = Number(run.source_boundary);
    const report = db.prepare("SELECT window_start, output_path FROM hourly_reports WHERE run_id = ?").get(runId);
    const output = report ? String(report.output_path) : path.normalize(saved.destination.path.replaceAll("\\", "/"));
    const info = { runId, name: saved.name, read: boundary, output };
    onStarted?.(runId);
    const started = db.prepare(`UPDATE export_runs SET status = 'running' WHERE run_id = ?
      AND status <> 'completed' AND (? = 0 OR status <> 'running')`).run(runId, Number(scheduled));
    if (!started.changes) {
      const status = db.prepare("SELECT status FROM export_runs WHERE run_id = ?").get(runId)!.status;
      return { ...info, skipped: status === "completed" ? "already completed" : "already running" };
    }
    try {
      // Pre-batching databases stored source positions but did not import inspections.
      const available = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS last FROM inspections").get()!;
      if (Number(available.last) < boundary) await importInspections(db);
      stageBatches(db, runId, saved, boundary, report ? Date.parse(String(report.window_start)) : undefined);
      const exported = await publishReport(db, runId, saved, output);
      return { ...info, exported };
    } catch (error) {
      db.prepare("UPDATE export_runs SET status = 'failed' WHERE run_id = ? AND status <> 'completed'").run(runId);
      throw error;
    }
  } finally {
    db.close();
  }
}
