import type { FastifyReply, FastifyRequest } from "fastify";
import { pingDb } from "../db/pool.js";
import { ingestLogs } from "../services/ingestService.js";

export async function healthHandler(_req: FastifyRequest, reply: FastifyReply) {
    const dbOk = await pingDb();
    if (!dbOk) {
        return reply.code(503).send({ status: "unavailable" });
    }
    return reply.code(200).send({ status: "ok" });
}

export async function ingestHandler(req: FastifyRequest, reply: FastifyReply) {
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
}