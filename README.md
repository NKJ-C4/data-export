# data-export
Customer Configurable Data Export Pipeline

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
