import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./pool.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

async function ensureMigrationsTable(): Promise<void> {
    await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function runMigrations(): Promise<void> {
    await ensureMigrationsTable();

    const files = readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort();

    const { rows } = await pool.query<{ name: string }>(
        "SELECT name FROM schema_migrations",
    );
    const applied = new Set(rows.map((r) => r.name));

    for (const file of files) {
        if (applied.has(file)) {
            console.log(`[migrate] skipping ${file} (already applied)`);
            continue;
        }

        const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(sql);
            await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
            await client.query("COMMIT");
            console.log(`[migrate] applied ${file}`);
        } catch (err) {
            await client.query("ROLLBACK");
            throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
        } finally {
            client.release();
        }
    }
}