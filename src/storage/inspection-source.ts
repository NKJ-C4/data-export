import { readFile } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import type { InspectionRecord } from "../domain/inspection-record";
import { transaction } from "./export-db";

// JSON is the demo's ingestion format. Once imported, each source position is immutable.
export async function importInspections(db: DatabaseSync): Promise<number> {
  const records: InspectionRecord[] = JSON.parse(await readFile("sample-data/inspection-records.json", "utf8"));
  if (!Array.isArray(records)) throw new Error("Expected an array of inspection records");

  return transaction(db, () => {
    const existing = db.prepare("SELECT sequence, record_json FROM inspections ORDER BY sequence");
    let count = 0;
    for (const row of existing.iterate()) {
      if (row.sequence !== count + 1 || JSON.stringify(records[count]) !== row.record_json) {
        throw new Error(`The inspection source is append-only. Existing position ${row.sequence} changed or disappeared.`);
      }
      count++;
    }
    const insert = db.prepare("INSERT INTO inspections (sequence, record_json) VALUES (?, ?)");
    for (let i = count; i < records.length; i++) {
      insert.run(i + 1, JSON.stringify(records[i]));
    }
    return records.length;
  });
}
