import { config } from "../config.js";
import { ensurePartitionForMonth, dropExpiredPartitions } from "../repositories/partitionRepository.js";

export async function runRetentionMaintenance(): Promise<void> {
    const now = new Date();
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    await ensurePartitionForMonth(now);
    await ensurePartitionForMonth(nextMonth);

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