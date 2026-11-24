import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../storage/export-db";
import { importInspections } from "../storage/inspection-source";
import type { ExportConfig } from "./export-config";

export const hourMs = 3_600_000;

export function reportingHour(start?: string, now = Date.now()): string {
  if (start === undefined) return new Date(Math.floor(now / hourMs) * hourMs - hourMs).toISOString();
  const time = Date.parse(start);
  if (!/^\d{4}-\d\d-\d\dT\d\d:00:00Z$/.test(start) || !Number.isFinite(time)
      || new Date(time).toISOString() !== start.replace("Z", ".000Z")) {
    throw new Error("Use a UTC hour start such as 2026-11-21T08:00:00Z");
  }
  if (time + hourMs > now) throw new Error("Choose a reporting hour that has already ended");
  return new Date(time).toISOString();
}

export async function hourlyRun(db: DatabaseSync, config: ExportConfig, start: string) {
  const key = [config.tenantId, config.name, start];
  const lookup = db.prepare(`SELECT run_id FROM hourly_reports
                             WHERE tenant_id = ? AND config_name = ? AND window_start = ?`);
  const existing = lookup.get(...key);
  if (existing) return String(existing.run_id);
  const boundary = await importInspections(db);
  return transaction(db, () => {
    const raced = lookup.get(...key);
    if (raced) return String(raced.run_id);
    const id = randomUUID();
    const base = path.normalize(config.destination.path.replaceAll("\\", "/")).slice(0, -4);
    const output = `${base}-${start.slice(0, 13)}Z.csv`;
    db.prepare("INSERT INTO export_runs (run_id, config_snapshot, source_boundary) VALUES (?, ?, ?)")
      .run(id, JSON.stringify(config), boundary);
    db.prepare("INSERT INTO hourly_reports (tenant_id, config_name, window_start, run_id, output_path) VALUES (?, ?, ?, ?, ?)")
      .run(...key, id, output);
    return id;
  });
}
