import type { FastifyInstance } from "fastify";
import { healthHandler } from "./handlers.js";

export async function registerRoutes(app: FastifyInstance) {
    app.get("/health", healthHandler);
}