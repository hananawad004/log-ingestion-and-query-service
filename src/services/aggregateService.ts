import { readPool } from "../db/pool.js";
import { ValidationError } from "../domain/errors.js";
import { LOG_LEVELS } from "../domain/logEntry.js";

export interface AggregateParams {
    service?: string;
    level?: string;
    attrs?: Record<string, string>;
    q?: string;
    since: string;
    until: string;
    bucket: string;
    group_by?: string;
}

export interface AggregateBucket {
    start: string;
    group: string | null;
    count: number;
}

export interface AggregateResult {
    buckets: AggregateBucket[];
}

const BUCKET_SECONDS: Record<string, number> = {
    "1m": 60,
    "5m": 300,
    "1h": 3600,
    "1d": 86400,
};

const VALID_GROUP_BY = new Set(["service", "level"]);

export async function aggregateLogs(params: AggregateParams): Promise<AggregateResult> {
    if (Number.isNaN(Date.parse(params.since))) {
        throw new ValidationError(`invalid 'since' timestamp: '${params.since}'`);
    }
    if (Number.isNaN(Date.parse(params.until))) {
        throw new ValidationError(`invalid 'until' timestamp: '${params.until}'`);
    }
    if (Date.parse(params.until) <= Date.parse(params.since)) {
        throw new ValidationError("'until' must be later than 'since'");
    }

    const bucketSeconds = BUCKET_SECONDS[params.bucket];
    if (bucketSeconds === undefined) {
        throw new ValidationError(
            `invalid bucket: '${params.bucket}' (must be one of 1m, 5m, 1h, 1d)`,
        );
    }

    if (params.group_by !== undefined && !VALID_GROUP_BY.has(params.group_by)) {
        throw new ValidationError(`invalid group_by: '${params.group_by}' (must be service or level)`);
    }

    if (params.level !== undefined && !(LOG_LEVELS as readonly string[]).includes(params.level)) {
        throw new ValidationError(`invalid level: '${params.level}'`);
    }

    // The rollup table only tracks (minute, service, level) counts — it has
    // no attribute or message data. Queries filtering on attr.* or q= can't
    // be answered from it, so they fall back to scanning `logs` directly.
    const canUseRollup = params.attrs === undefined && params.q === undefined;

    return canUseRollup
        ? aggregateFromRollup(params, bucketSeconds)
        : aggregateFromRawLogs(params, bucketSeconds);
}

async function aggregateFromRollup(
    params: AggregateParams,
    bucketSeconds: number,
): Promise<AggregateResult> {
    const conditions: string[] = ["bucket_start >= $1", "bucket_start < $2"];
    const values: unknown[] = [params.since, params.until];

    if (params.service !== undefined) {
        values.push(params.service);
        conditions.push(`service = $${values.length}`);
    }
    if (params.level !== undefined) {
        values.push(params.level);
        conditions.push(`level = $${values.length}`);
    }

    const groupByColumn = params.group_by;
    const groupExpr = groupByColumn ? groupByColumn : "NULL";

    const bucketExpr = `to_timestamp(floor(extract(epoch from bucket_start) / ${bucketSeconds}) * ${bucketSeconds})`;

    const sql = `
    SELECT
      ${bucketExpr} AS bucket_start,
      ${groupExpr} AS group_value,
      SUM(count)::int AS count
    FROM logs_rollup_1m
    WHERE ${conditions.join(" AND ")}
    GROUP BY bucket_start, group_value
    ORDER BY bucket_start ASC
  `;

    const { rows } = await readPool.query(sql, values);

    return {
        buckets: rows.map((row) => ({
            start: new Date(row.bucket_start).toISOString(),
            group: row.group_value,
            count: row.count,
        })),
    };
}

async function aggregateFromRawLogs(
    params: AggregateParams,
    bucketSeconds: number,
): Promise<AggregateResult> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    function addCondition(sqlFragment: string, value: unknown): void {
        values.push(value);
        conditions.push(sqlFragment.replace("?", `$${values.length}`));
    }

    addCondition("ts >= ?", params.since);
    addCondition("ts < ?", params.until);

    if (params.service !== undefined) {
        addCondition("service = ?", params.service);
    }

    if (params.level !== undefined) {
        addCondition("level = ?", params.level);
    }

    if (params.q !== undefined) {
        addCondition("message ILIKE ?", `%${params.q}%`);
    }

    if (params.attrs) {
        for (const [key, value] of Object.entries(params.attrs)) {
            addCondition("attributes_str @> ?::jsonb", JSON.stringify({ [key]: value }));
        }
    }

    const bucketExpr = `to_timestamp(floor(extract(epoch from ts) / ${bucketSeconds}) * ${bucketSeconds})`;

    const groupByColumn = params.group_by;
    const groupExpr = groupByColumn ? groupByColumn : "NULL";

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const sql = `
    SELECT
      ${bucketExpr} AS bucket_start,
      ${groupExpr} AS group_value,
      COUNT(*)::int AS count
    FROM logs
    ${whereClause}
    GROUP BY bucket_start, group_value
    ORDER BY bucket_start ASC
  `;

    const { rows } = await readPool.query(sql, values);

    return {
        buckets: rows.map((row) => ({
            start: new Date(row.bucket_start).toISOString(),
            group: row.group_value,
            count: row.count,
        })),
    };
}