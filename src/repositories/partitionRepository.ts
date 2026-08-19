import { pool } from "../db/pool.js";

export interface PartitionInfo {
    partitionName: string;
    rangeStart: Date;
    rangeEnd: Date;
}

function monthRange(date: Date): { start: Date; end: Date; name: string } {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth(); // 0-indexed
    const start = new Date(Date.UTC(year, month, 1));
    const end = new Date(Date.UTC(year, month + 1, 1));
    const name = `logs_y${year}_m${String(month + 1).padStart(2, "0")}`;
    return { start, end, name };
}

export async function listPartitions(): Promise<PartitionInfo[]> {
    const { rows } = await pool.query<{
        partition_name: string;
        range_start: string;
        range_end: string;
    }>("SELECT partition_name, range_start, range_end FROM log_partitions ORDER BY range_start");

    return rows.map((r) => ({
        partitionName: r.partition_name,
        rangeStart: new Date(r.range_start),
        rangeEnd: new Date(r.range_end),
    }));
}

export async function ensurePartitionForMonth(date: Date): Promise<void> {
    const { start, end, name } = monthRange(date);

    const { rows } = await pool.query("SELECT 1 FROM log_partitions WHERE partition_name = $1", [
        name,
    ]);
    if (rows.length > 0) return;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // DDL statements cannot use $1/$2 placeholders (PostgreSQL protocol
        // limitation for utility statements). These values are computed
        // server-side from Date objects (never user input), so safe literal
        // interpolation via quote_literal-style ISO strings is fine here.
        await client.query(
            `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF logs FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`,
        );
        await client.query(
            `INSERT INTO log_partitions (partition_name, range_start, range_end)
             VALUES ($1, $2, $3)
                 ON CONFLICT (partition_name) DO NOTHING`,
            [name, start.toISOString(), end.toISOString()],
        );
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

export async function dropExpiredPartitions(retentionDays: number): Promise<string[]> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const partitions = await listPartitions();
    const dropped: string[] = [];

    for (const p of partitions) {
        if (p.rangeEnd > cutoff) continue;

        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`DROP TABLE IF EXISTS ${p.partitionName}`);
            await client.query("DELETE FROM log_partitions WHERE partition_name = $1", [
                p.partitionName,
            ]);
            await client.query("COMMIT");
            dropped.push(p.partitionName);
        } catch (err) {
            await client.query("ROLLBACK");
            throw err;
        } finally {
            client.release();
        }
    }

    return dropped;
}