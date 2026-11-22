import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { runExport } from "./export/run-export";

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  const usage = "Usage: npm run export -- --config config/failed-inspections.json";
  if (values.help) {
    console.log(usage);
    return;
  }
  if (!values.config) throw new Error(usage);
  const result = await runExport(values.config);
  console.log(`${result.name}: exported ${result.exported} of ${result.read} records to ${result.output}`);
}

main().catch((error: unknown) => {
  if (error instanceof ZodError) {
    for (const issue of error.issues) console.error(`${issue.path.join(".")}: ${issue.message}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
