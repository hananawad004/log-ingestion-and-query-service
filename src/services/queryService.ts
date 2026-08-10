import { pool } from "../db/pool.js";
import { decodeCursor, encodeCursor } from "../utils/cursor.js";
import { ValidationError } from "../domain/errors.js";
import type { LogLevel } from "../domain/logEntry.js";
import { LOG_LEVELS } from "../domain/logEntry.js";

export interface QueryLogsParams {
    service?: string;
    level?: string;
    since?: string;
    until?: string;
    attrs?: Record<string, string>;
    q?: string;
    limit?: number;
    cursor?: string;
}

export interface LogRow {
    id: string;
    timestamp: string;
    level: LogLevel;
    service: string;
    message: string;
    attributes: Record<string, unknown>;
}

export interface QueryLogsResult {
    logs: LogRow[];
    next_cursor: string | null;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

export async function queryLogs(params: QueryLogsParams): Promise<QueryLogsResult> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    function addCondition(sqlFragment: string, value: unknown): void {
        values.push(value);
        conditions.push(sqlFragment.replace("?", `$${values.length}`));
    }

    if (params.service !== undefined) {
        addCondition("service = ?", params.service);
    }

    if (params.level !== undefined) {
        if (!(LOG_LEVELS as readonly string[]).includes(params.level)) {
            throw new ValidationError(`invalid level: '${params.level}'`);
        }
        addCondition("level = ?", params.level);
    }

    if (params.since !== undefined) {
        if (Number.isNaN(Date.parse(params.since))) {
            throw new ValidationError(`invalid 'since' timestamp: '${params.since}'`);
        }
        addCondition("ts >= ?", params.since);
    }

    if (params.until !== undefined) {
        if (Number.isNaN(Date.parse(params.until))) {
            throw new ValidationError(`invalid 'until' timestamp: '${params.until}'`);
        }
        addCondition("ts < ?", params.until);
    }

    if (params.since !== undefined && params.until !== undefined) {
        if (Date.parse(params.until) <= Date.parse(params.since)) {
            throw new ValidationError("'until' must be later than 'since'");
        }
    }

    if (params.q !== undefined) {
        addCondition("message ILIKE ?", `%${params.q}%`);
    }

    if (params.attrs) {
        for (const [key, value] of Object.entries(params.attrs)) {
            addCondition(`attributes ->> '${key}' = ?`, value);
        }
    }

    const limit = resolveLimit(params.limit);

    if (params.cursor !== undefined) {
        const decoded = decodeCursor(params.cursor);
        addCondition("(ts, id) < (?, ?::bigint)", decoded.ts);
        values.push(decoded.id);
        conditions[conditions.length - 1] = conditions[conditions.length - 1]!.replace(
            "?::bigint",
            `$${values.length}::bigint`,
        );
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
    SELECT id, ts, level, service, message, attributes
    FROM logs
    ${whereClause}
    ORDER BY ts DESC, id DESC
    LIMIT ${limit + 1}
  `;

    const { rows } = await pool.query(sql, values);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const logs: LogRow[] = pageRows.map((row) => ({
        id: String(row.id),
        timestamp: new Date(row.ts).toISOString(),
        level: row.level,
        service: row.service,
        message: row.message,
        attributes: row.attributes,
    }));

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
        hasMore && lastRow
            ? encodeCursor({ ts: new Date(lastRow.ts).toISOString(), id: Number(lastRow.id) })
            : null;

    return { logs, next_cursor: nextCursor };
}

function resolveLimit(rawLimit: number | undefined): number {
    if (rawLimit === undefined) return DEFAULT_LIMIT;
    if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_LIMIT) {
        throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}`);
    }
    return rawLimit;
}