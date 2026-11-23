# data-export
Customer Configurable Data Export Pipeline

Architecture for the shared production platform and the current prototype is documented in [docs/architecture.md](docs/architecture.md). The visual overview is available in [docs/architecture.html](docs/architecture.html).

From the project root, install dependencies and run the two reports over the same eight sample inspections.

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
preserves existing rows. Recording a run when a CSV export starts is the next step.
