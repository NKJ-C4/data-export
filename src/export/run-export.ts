import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "csv/sync";
import type { InspectionRecord } from "../domain/inspection-record";
import { validateExportConfig, type ExportConfig } from "./export-config";

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

async function saveReport(destination: string, csv: string) {
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
  const temporary = path.join(parent, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, csv, { flag: "wx" });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function runExport(configPath: string) {
  const config = validateExportConfig(JSON.parse(await readFile(configPath, "utf8")));
  // The source for this milestone is the repository's inspection fixture.
  const records: InspectionRecord[] = JSON.parse(
    await readFile("sample-data/inspection-records.json", "utf8"),
  );
  const selected = records.filter(record => matches(record, config));
  const headers = config.columns.map(column => column.header);
  const rows = selected.map(record => config.columns.map(column => cell(record, column)));
  const output = path.normalize(config.destination.path.replaceAll("\\", "/"));
  await saveReport(output, stringify([headers, ...rows], { escape_formulas: true }));
  return { name: config.name, read: records.length, exported: selected.length, output };
}
