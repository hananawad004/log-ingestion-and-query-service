import Fastify from "fastify";
import { config } from "./config.js";
import { registerRoutes } from "./http/routes.js";
import { runMigrations } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { startRetentionScheduler } from "./services/retentionService.js";

async function main() {
    console.log("Running database migrations...");
    await runMigrations();
    console.log("Migrations complete.");

    const retentionTimer = startRetentionScheduler();

    const app = Fastify({ logger: true });
    await registerRoutes(app);

    await app.listen({ port: config.port, host: config.host });
    console.log(`Server listening on ${config.host}:${config.port}`);

    const shutdown = async () => {
        console.log("Shutting down...");
        clearInterval(retentionTimer);
        await app.close();
        await pool.end();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((err) => {
    console.error("Fatal error during startup:", err);
    process.exit(1);
});