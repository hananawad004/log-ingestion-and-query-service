import { pool } from "./pool.js";
import { config } from "../config.js";

export async function applyOptionalIndexes(): Promise<void> {
    if (config.enableMessageSearchIndex) {
        console.log("[optional-features] enabling message search index (pg_trgm)...");
        await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
        await pool.query(
            "CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING GIN (message gin_trgm_ops)",
        );
    } else {
        await pool.query("DROP INDEX IF EXISTS idx_logs_message_trgm");
    }
}