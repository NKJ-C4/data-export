import { parseArgs } from "node:util";
import { ZodError } from "zod";
import { runExport } from "./export/run-export";
import { reportingHour } from "./export/hourly";

async function main() {
  const { values } = parseArgs({ options: {
    config: { type: "string" },
    resume: { type: "string" },
    hourly: { type: "boolean" },
    hour: { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  const usage = "Use --config <file> [--hourly [--hour YYYY-MM-DDTHH:00:00Z]] or --resume <run-id>.";
  if (values.help) {
    console.log(usage);
    return;
  }
  debugger;
  if (Boolean(values.config) === Boolean(values.resume)) throw new Error(usage);
  if ((values.hourly && !values.config) || (values.hour !== undefined && !values.hourly)) throw new Error(usage);
  const request = values.config
    ? { configPath: values.config, hour: values.hourly ? reportingHour(values.hour) : undefined }
    : { runId: values.resume! };
  const result = await runExport(request, runId => console.log(`Run ID: ${runId}`));
  if ("skipped" in result) {
    console.log(`Run ${result.skipped}: ${result.output}`);
    return;
  }
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
