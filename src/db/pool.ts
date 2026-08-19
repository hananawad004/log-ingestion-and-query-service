import pg from "pg";
import { config } from "../config.js";

const { Pool } = pg;

export const pool = new Pool({
    host: config.pg.host,
    port: config.pg.port,
    user: config.pg.user,
    password: config.pg.password,
    database: config.pg.database,
    max: config.pg.maxPoolSize,
    idleTimeoutMillis: config.pg.idleTimeoutMillis,
    statement_timeout: config.pg.statementTimeoutMs,
});

export const readPool = new pg.Pool({
    host: config.pg.host,
    port: config.pg.port,
    user: config.pg.user,
    password: config.pg.password,
    database: config.pg.database,
    max: 6, // small dedicated pool for read queries
    idleTimeoutMillis: config.pg.idleTimeoutMillis,
    statement_timeout: config.pg.statementTimeoutMs,
});
pool.on("error", (err) => {
    console.error("[pg pool] unexpected error on idle client", err);
});

export async function pingDb(): Promise<boolean> {
    try {
        await pool.query("SELECT 1");
        return true;
    } catch {
        return false;
    }
}