import type { FastifyInstance } from "fastify";
import {aggregateHandler, healthHandler, ingestHandler, queryHandler} from "./handlers.js";

export async function registerRoutes(app: FastifyInstance) {
    app.get("/health", healthHandler);
    app.post("/logs", ingestHandler);
    app.get("/logs", queryHandler);
    app.get("/logs/aggregate", aggregateHandler);
}