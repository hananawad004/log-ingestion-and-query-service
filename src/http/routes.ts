import type { FastifyInstance } from "fastify";
import {healthHandler, ingestHandler} from "./handlers.js";

export async function registerRoutes(app: FastifyInstance) {
    app.get("/health", healthHandler);
    app.post("/logs", ingestHandler);
}