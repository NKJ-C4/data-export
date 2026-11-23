import { defaultDatabasePath, openExportDatabase } from "./export-db";

const db = openExportDatabase();
db.close();
console.log(`Export database ready at ${defaultDatabasePath}`);
