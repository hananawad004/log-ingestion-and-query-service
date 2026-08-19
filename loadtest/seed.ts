import { pool } from "../src/db/pool.js";

const TOTAL_ROWS = Number(process.env.SEED_ROWS ?? 1_000_000);
const BATCH_SIZE = 10_000;
const DAYS_SPREAD = 30;

const LEVELS = ["debug", "info", "warn", "error"];
const SERVICES = ["checkout", "auth", "search", "payments", "notifications"];

function randomTimestampWithinDays(days: number): Date {
    const now = Date.now();
    const spreadMs = days * 24 * 60 * 60 * 1000;
    const randomOffset = Math.random() * spreadMs;
    return new Date(now - randomOffset);
}

function randomFrom<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)]!;
}

async function seedBatch(size: number): Promise<void> {
    const timestamps: string[] = [];
    const levels: string[] = [];
    const services: string[] = [];
    const messages: string[] = [];
    const attributes: string[] = [];

    for (let i = 0; i < size; i++) {
        timestamps.push(randomTimestampWithinDays(DAYS_SPREAD).toISOString());
        levels.push(randomFrom(LEVELS));
        services.push(randomFrom(SERVICES));
        messages.push(`seeded log message ${Math.random().toString(36).slice(2)}`);
        attributes.push(
            JSON.stringify({
                user_id: String(Math.floor(Math.random() * 10000)),
                region: randomFrom(["eu-west", "us-east", "ap-south"]),
                retries: Math.floor(Math.random() * 5),
            }),
        );
    }

    await pool.query(
        `INSERT INTO logs (ts, level, service, message, attributes)
     SELECT * FROM unnest($1::timestamptz[], $2::text[], $3::text[], $4::text[], $5::jsonb[])`,
        [timestamps, levels, services, messages, attributes],
    );
}

async function main() {
    console.log(`Seeding ${TOTAL_ROWS.toLocaleString()} rows spread over ${DAYS_SPREAD} days...`);
    const start = Date.now();

    let inserted = 0;
    while (inserted < TOTAL_ROWS) {
        const size = Math.min(BATCH_SIZE, TOTAL_ROWS - inserted);
        await seedBatch(size);
        inserted += size;
        if (inserted % 100_000 === 0 || inserted === TOTAL_ROWS) {
            console.log(`  ${inserted.toLocaleString()} / ${TOTAL_ROWS.toLocaleString()} inserted...`);
        }
    }

    const elapsedSec = (Date.now() - start) / 1000;
    console.log(`\nDone. Inserted ${TOTAL_ROWS.toLocaleString()} rows in ${elapsedSec.toFixed(1)}s`);
    console.log(`Average rate: ${(TOTAL_ROWS / elapsedSec).toFixed(0)} rows/sec`);

    await pool.end();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});