import { pool } from "../db/pool.js";

// In-memory buffer for rollup counts, flushed periodically to
// logs_rollup_1m. This decouples rollup maintenance from the hot
// ingestion path entirely: instead of one UPSERT per insert batch
// (which caused heavy row-lock contention under concurrent load, since
// many concurrent batches update the same current-minute rows),
// increments are accumulated in memory and flushed with a single
// batched UPSERT every FLUSH_INTERVAL_MS.
//
// Trade-off: aggregate counts served from the rollup fast path can lag
// live ingestion by up to FLUSH_INTERVAL_MS, and a small window of
// increments can be lost on an unclean process crash. This only
// affects the rollup used for fast aggregate queries -- raw `logs`
// rows are committed independently and are never affected.

const FLUSH_INTERVAL_MS = Number(process.env.ROLLUP_FLUSH_INTERVAL_MS ?? 1000);

let buffer = new Map<string, number>();

function bufferKey(bucketStart: string, service: string, level: string): string {
    return `${bucketStart}|${service}|${level}`;
}

export function recordRollupDeltas(
    entries: { timestamp: string; service: string; level: string }[],
): void {
    for (const e of entries) {
        const bucketStart = new Date(e.timestamp);
        bucketStart.setUTCSeconds(0, 0);
        const key = bufferKey(bucketStart.toISOString(), e.service, e.level);
        buffer.set(key, (buffer.get(key) ?? 0) + 1);
    }
}

export async function flushRollupBuffer(): Promise<void> {
    if (buffer.size === 0) return;

    const toFlush = buffer;
    buffer = new Map();

    const bucketStarts: string[] = [];
    const services: string[] = [];
    const levels: string[] = [];
    const counts: number[] = [];

    for (const [key, count] of toFlush.entries()) {
        const [bucketStart, service, level] = key.split("|");
        bucketStarts.push(bucketStart!);
        services.push(service!);
        levels.push(level!);
        counts.push(count);
    }

    try {
        await pool.query(
            `INSERT INTO logs_rollup_1m (bucket_start, service, level, count)
       SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::bigint[])
       ON CONFLICT (bucket_start, service, level)
       DO UPDATE SET count = logs_rollup_1m.count + EXCLUDED.count`,
            [bucketStarts, services, levels, counts],
        );
    } catch (err) {
        console.error("[rollup] flush failed, deltas dropped:", err);
    }
}

export function startRollupFlushScheduler(): NodeJS.Timeout {
    return setInterval(() => {
        flushRollupBuffer().catch((err) => {
            console.error("[rollup] scheduled flush failed:", err);
        });
    }, FLUSH_INTERVAL_MS);
}