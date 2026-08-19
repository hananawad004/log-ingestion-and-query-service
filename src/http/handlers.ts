import type { FastifyReply, FastifyRequest } from "fastify";
import { pingDb } from "../db/pool.js";
import { ingestLogs } from "../services/ingestService.js";
import { queryLogs } from "../services/queryService.js";
import { aggregateLogs } from "../services/aggregateService.js";
import { ValidationError, InvalidCursorError } from "../domain/errors.js";

// Simple in-flight request counter for /logs ingestion. If the number of
// concurrently-processing insert requests exceeds a safe threshold, new
// requests are shed with 503 + Retry-After instead of being accepted and
// left to queue indefinitely -- which is what caused accepted-but-invisible
// records under extreme sustained load (see README, Eventual Consistency).
// The threshold is set well above the 15,000 logs/sec baseline target, so
// it only engages during genuine overload (stress/spike/breakpoint-level
// traffic), never during normal operation.
const MAX_CONCURRENT_INGESTS = Number(process.env.MAX_CONCURRENT_INGESTS ?? 40);
let inFlightIngests = 0;
export async function healthHandler(_req: FastifyRequest, reply: FastifyReply) {
    const dbOk = await pingDb();
    if (!dbOk) {
        return reply.code(503).send({ status: "unavailable" });
    }
    return reply.code(200).send({ status: "ok" });
}

export async function ingestHandler(req: FastifyRequest, reply: FastifyReply) {
    if (inFlightIngests >= MAX_CONCURRENT_INGESTS) {
        reply.header("Retry-After", "1");
        return reply.code(503).send({ error: "server is at capacity, please retry shortly" });
    }

    inFlightIngests++;
    try {
        const body = req.body;

        if (
            typeof body !== "object" ||
            body === null ||
            !("logs" in body) ||
            !Array.isArray((body as Record<string, unknown>).logs)
        ) {
            return reply.code(400).send({ error: "request body must be an object with a 'logs' array" });
        }

        const rawEntries = (body as { logs: unknown[] }).logs;
        const result = await ingestLogs(rawEntries);

        if (result.accepted === 0) {
            return reply.code(400).send(result);
        }

        return reply.code(200).send(result);
    } finally {
        inFlightIngests--;
    }
}
const VALID_ATTR_KEY = /^[a-zA-Z0-9_]+$/;

export async function queryHandler(req: FastifyRequest, reply: FastifyReply) {
    const query = req.query as Record<string, string | undefined>;

    try {
        const attrs: Record<string, string> = {};
        for (const [key, value] of Object.entries(query)) {
            if (key.startsWith("attr.") && value !== undefined) {
                const attrKey = key.slice("attr.".length);
                if (!VALID_ATTR_KEY.test(attrKey)) {
                    return reply.code(400).send({ error: `invalid attribute key: '${attrKey}'` });
                }
                attrs[attrKey] = value;
            }
        }

        const limit = query.limit !== undefined ? parseLimit(query.limit) : undefined;

        const result = await queryLogs({
            service: query.service,
            level: query.level,
            since: query.since,
            until: query.until,
            q: query.q,
            cursor: query.cursor,
            limit,
            attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
        });

        return reply.code(200).send(result);
    } catch (err) {
        if (err instanceof ValidationError || err instanceof InvalidCursorError) {
            return reply.code(400).send({ error: err.message });
        }
        throw err;
    }
}

function parseLimit(raw: string): number {
    const n = Number(raw);
    if (!Number.isInteger(n)) {
        throw new ValidationError(`limit must be an integer: '${raw}'`);
    }
    return n;
}

export async function aggregateHandler(req: FastifyRequest, reply: FastifyReply) {
    const query = req.query as Record<string, string | undefined>;

    try {
        const attrs: Record<string, string> = {};
        for (const [key, value] of Object.entries(query)) {
            if (key.startsWith("attr.") && value !== undefined) {
                const attrKey = key.slice("attr.".length);
                if (!VALID_ATTR_KEY.test(attrKey)) {
                    return reply.code(400).send({ error: `invalid attribute key: '${attrKey}'` });
                }
                attrs[attrKey] = value;
            }
        }

        if (query.since === undefined) {
            return reply.code(400).send({ error: "'since' is required" });
        }
        if (query.until === undefined) {
            return reply.code(400).send({ error: "'until' is required" });
        }
        if (query.bucket === undefined) {
            return reply.code(400).send({ error: "'bucket' is required" });
        }

        const result = await aggregateLogs({
            service: query.service,
            level: query.level,
            q: query.q,
            since: query.since,
            until: query.until,
            bucket: query.bucket,
            group_by: query.group_by,
            attrs: Object.keys(attrs).length > 0 ? attrs : undefined,
        });

        return reply.code(200).send(result);
    } catch (err) {
        if (err instanceof ValidationError) {
            return reply.code(400).send({ error: err.message });
        }
        throw err;
    }
}