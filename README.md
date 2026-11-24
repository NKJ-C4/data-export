# data-export
Customer Configurable Data Export Pipeline

I spent roughly 12–14 active hours on this assignment across sessions from Saturday night through Tuesday. I built an hourly CSV exporter that lets customers choose which inspections to include and how to format the columns. It saves progress in SQLite so an interrupted run can resume without duplicating rows in the report. I used a local inspection dataset, local CSV files, and host cron to keep the demo easy to run. For production, I’d first enforce tenant and workspace permissions, then add automatic recovery so a stalled hourly report can finish without an operator restarting it.

The [design document](docs/architecture.md) includes the architecture diagram, all three customer scenarios, and the rollout and recovery trade-offs.

Use Node.js 22.22.1 (tested) and npm. From the cloned project root, install dependencies and run the two reports over the same eight sample inspections. All demo commands, including hourly replay and recovery tests, work without installing a cron job.

```sh
npm ci
npm run export -- --config config/failed-inspections.json
npm run export -- --config config/high-confidence-inspections.json
npm test
```

Open `output/failed-inspections.csv` to see the four failures. Open
`output/high-confidence-inspections.csv` to see the five inspections with confidence of at least 80%.
The export tests run the CLI in temporary directories and check the CSV contents.

To initialize the local run database, run `npm run db:init` from the project root
with Node 22.22.1 (tested). This uses Node’s built-in SQLite client and creates
`data/export.sqlite` with an empty `export_runs` table. Re-running the command
preserves existing rows. Running an export also initializes the database automatically.

Each new export imports the append-only JSON fixture into SQLite. Keep existing
entries in their original order and append new inspections at the end. The CLI
prints a run ID and saves the config and the last source position for that run.
For the sample that position is 8, even when only 4 inspections match.

To continue a failed or interrupted run, use its printed ID from the same project
directory. Keep `data/export.sqlite` between attempts.

```sh
npm run export -- --resume <run-id>
```

The worker reads two inspections per batch. It commits the formatted rows and the
last inspected position together, including batches with zero matches. Resume
uses the saved settings and source positions. After scanning, it writes one header
and the staged rows in order, then renames the temporary file to the configured
CSV path. A retry after publication failure only needs to publish the staged rows.
Resuming a completed run reports its status and leaves the destination alone.

Run `npm run demo:recovery` to see a real CLI export fail and resume in a temporary directory.
The demo blocks the checkpoint update only once inspection 4's output row has been staged.
After rollback, checkpoint 2 and its matching row survive. The demo removes the fault,
resumes the same run in a fresh process, and compares its CSV bytes with an uninterrupted run.

For the automated regression test, run `npm test -- tests/export-cli.test.ts -t "rolls back a partial batch"`.
The test interrupts the second batch, adds a later inspection, and verifies that
resuming produces the same bytes as an uninterrupted report. The demo reads the
JSON seed into memory when starting a new run. Batch processing and CSV publication
read from SQLite incrementally.

### Hourly CSV reports

Try the sample's 08:00–09:00 UTC report from the project root:

```sh
npm run export -- --config config/failed-inspections.json --hourly --hour 2026-11-21T08:00:00Z
```

The first run writes four rows to `output/failed-inspections-2026-11-21T08Z.csv`.
Run it twice to see the same run ID. Without `--hour`, the handler picks the most
recently finished UTC hour. An empty hour produces a header-only report.

For automatic delivery on an awake host with cron running, add the entry from
[ops/hourly.cron](ops/hourly.cron) using `crontab -e`. In the template, replace
`/absolute/path/to/data-export` with the output of `pwd -P` from your checkout and
`/absolute/path/to/node` with the output of `node -p "process.execPath"`.
Use a UTC cron host for top-of-UTC-hour delivery.
One entry schedules one report. Keep the config name stable and the destination
basename distinct per report. SQLite identifies each report by tenant, config
name and UTC hour. A repeat trigger skips a completed or running report and
retries a failed one using the saved config, boundary and path. After a hard stop,
confirm the old process has exited and use `--resume <run-id>`. Replay a missed
hour with the explicit-hour command above. Published windows keep their original
source boundary if late inspections arrive.

## Extras

The exporter runs from the command line and has no graphical UI. I used ChatGPT to create an optional [HTML walkthrough](docs/export-walkthrough.html) so you can see how it works. Open the file in a browser to follow eight sample inspections through a simulated export, see what survives an interruption, and compare the CSVs produced by two configurations.
