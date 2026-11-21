import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateExportConfig } from "../src/export/export-config";

function loadJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("validateExportConfig", () => {
  it.each([
    "config/failed-inspections.json",
    "config/high-confidence-inspections.json",
  ])("accepts sample configuration %s", (configPath) => {
    expect(() => validateExportConfig(loadJson(configPath))).not.toThrow();
  });

  it("rejects a confidence outside the 0-to-1 range", () => {
    const config = loadJson("config/high-confidence-inspections.json") as any;
    config.filters.minimumConfidence = 1.2;

    expect(() => validateExportConfig(config)).toThrow();
  });

  it("rejects duplicate column headers", () => {
    const config = loadJson("config/failed-inspections.json") as any;
    config.columns[1].header = config.columns[0].header;

    expect(() => validateExportConfig(config)).toThrow(/Duplicate column header/);
  });

  it("rejects a destination outside the output directory", () => {
    const config = loadJson("config/failed-inspections.json") as any;
    config.destination.path = "../failed-inspections.csv";

    expect(() => validateExportConfig(config)).toThrow(
      "Destination path must be a relative path inside output/",
    );
  });

  it("rejects a transform that does not match the field type", () => {
    const config = loadJson("config/failed-inspections.json") as any;
    config.columns[0].transform = "percentage";

    expect(() => validateExportConfig(config)).toThrow(
      /Transform.*percentage.*cannot be applied.*id/,
    );
  });
});
