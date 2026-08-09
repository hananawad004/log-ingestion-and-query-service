import type { FastifyReply, FastifyRequest } from "fastify";
import { pingDb } from "../db/pool.js";

export async function healthHandler(_req: FastifyRequest, reply: FastifyReply) {
    const dbOk = await pingDb();
    if (!dbOk) {
        return reply.code(503).send({ status: "unavailable" });
    }
    return reply.code(200).send({ status: "ok" });
}