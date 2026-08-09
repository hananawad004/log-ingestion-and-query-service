import { runMigrations } from "../db/migrate.js";
import { pool } from "../db/pool.js";

async function main() {
    console.log("Running migrations...");
    await runMigrations();
    console.log("Done.");
    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});