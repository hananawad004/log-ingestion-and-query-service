import autocannon from "autocannon";

const TARGET_URL = process.env.TARGET_URL ?? "http://localhost:8080/logs";
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 100);
const DURATION_SEC = Number(process.env.DURATION_SEC ?? 20);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 20);

function randomLevel(): string {
    const levels = ["debug", "info", "warn", "error"];
    return levels[Math.floor(Math.random() * levels.length)]!;
}

function randomService(): string {
    const services = ["checkout", "auth", "search", "payments", "notifications"];
    return services[Math.floor(Math.random() * services.length)]!;
}

function buildBatch(size: number) {
    const logs = [];
    for (let i = 0; i < size; i++) {
        logs.push({
            timestamp: new Date().toISOString(),
            level: randomLevel(),
            service: randomService(),
            message: `load test message ${Math.random().toString(36).slice(2)}`,
            attributes: {
                user_id: String(Math.floor(Math.random() * 10000)),
                region: "eu-west",
                retries: Math.floor(Math.random() * 5),
            },
        });
    }
    return { logs };
}

async function main() {
    console.log(`\n=== Load test: batch size = ${BATCH_SIZE}, duration = ${DURATION_SEC}s, connections = ${CONNECTIONS} ===\n`);

    const body = JSON.stringify(buildBatch(BATCH_SIZE));

    const result = await autocannon({
        url: TARGET_URL,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        duration: DURATION_SEC,
        connections: CONNECTIONS,
    });

    const requestsPerSec = result.requests.average;
    const logsPerSec = requestsPerSec * BATCH_SIZE;

    console.log("\n=== Results ===");
    console.log(`Requests/sec (avg): ${requestsPerSec.toFixed(1)}`);
    console.log(`Logs/sec (avg): ${logsPerSec.toFixed(1)}`);
    console.log(`Latency p50: ${result.latency.p50}ms`);
    console.log(`Latency p95: ${result.latency.p97_5}ms`);
    console.log(`Latency p99: ${result.latency.p99}ms`);
    console.log(`Errors: ${result.errors}`);
    console.log(`Timeouts: ${result.timeouts}`);
    console.log(`Non-2xx responses: ${result.non2xx}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});