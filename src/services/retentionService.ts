import { config } from "../config.js";
import { ensurePartitionForMonth, dropExpiredPartitions } from "../repositories/partitionRepository.js";

export async function runRetentionMaintenance(): Promise<void> {
    const now = new Date();

    // Ensure a partition exists for every month touched by the retention
    // window, not just "now". Data can span back up to `retentionDays`
    // (per spec, ~30 days = "approximately one month"), so without this,
    // older records fall into the unoptimized `logs_default` catch-all
    // partition and queries spanning that range become much slower.
    const retentionDays = config.retentionDays;
    const windowStart = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

    let cursor = new Date(Date.UTC(windowStart.getUTCFullYear(), windowStart.getUTCMonth(), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)); // through next month

    while (cursor <= end) {
        await ensurePartitionForMonth(cursor);
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
    }

    const dropped = await dropExpiredPartitions(config.retentionDays);
    if (dropped.length > 0) {
        console.log(`[retention] dropped expired partitions: ${dropped.join(", ")}`);
    }
}

export function startRetentionScheduler(): NodeJS.Timeout {
    runRetentionMaintenance().catch((err) => {
        console.error("[retention] initial run failed:", err);
    });

    return setInterval(() => {
        runRetentionMaintenance().catch((err) => {
            console.error("[retention] scheduled run failed:", err);
        });
    }, config.retentionIntervalMs);
}