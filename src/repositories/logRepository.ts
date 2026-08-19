import { pool } from "../db/pool.js";
import type { ValidatedLogEntry } from "../validation/logValidator.js";

import { recordRollupDeltas } from "../services/rollupBuffer.js";

export async function insertBatch(entries: ValidatedLogEntry[]): Promise<number> {
    if (entries.length === 0) return 0;

    const timestamps = entries.map((e) => e.timestamp);
    const levels = entries.map((e) => e.level);
    const services = entries.map((e) => e.service);
    const messages = entries.map((e) => e.message);
    const attributes = entries.map((e) => JSON.stringify(e.attributes));

    await pool.query(
        `INSERT INTO logs (ts, level, service, message, attributes)
     SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::jsonb[])`,
        [timestamps, levels, services, messages, attributes],
    );

    recordRollupDeltas(
        entries.map((e) => ({ timestamp: e.timestamp, service: e.service, level: e.level })),
    );

    return entries.length;
}