export const config = {
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST ?? "0.0.0.0",

    pg: {
        host: process.env.PGHOST ?? "postgres",
        port: Number(process.env.PGPORT ?? 5432),
        user: process.env.PGUSER ?? "loguser",
        password: process.env.PGPASSWORD ?? "logpass",
        database: process.env.PGDATABASE ?? "logs",
        maxPoolSize: Number(process.env.PG_POOL_MAX ?? 12),
        idleTimeoutMillis: Number(process.env.PG_POOL_IDLE_MS ?? 30_000),
        statementTimeoutMs: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 10_000),
    },

    retentionDays: Number(process.env.RETENTION_DAYS ?? 30),
    retentionIntervalMs: Number(process.env.RETENTION_INTERVAL_MS ?? 60 * 60 * 1000),

    authEnabled: (process.env.AUTH_ENABLED ?? "false").toLowerCase() === "true",
    loadgenApiKey: process.env.LOADGEN_API_KEY ?? null,

    defaultQueryLimit: 100,
    maxQueryLimit: 1000,
    enableMessageSearchIndex: (process.env.ENABLE_MESSAGE_SEARCH_INDEX ?? "false").toLowerCase() === "true",
};