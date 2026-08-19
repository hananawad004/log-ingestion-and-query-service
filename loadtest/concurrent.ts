import autocannon from "autocannon";

const BASE_URL = process.env.TARGET_BASE_URL ?? "http://localhost:8080";
const BATCH_SIZE = Number(process.env.BATCH_SIZE ?? 1000);
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
            message: `concurrent test message ${Math.random().toString(36).slice(2)}`,
            attributes: { user_id: String(Math.floor(Math.random() * 10000)) },
        });
    }
    return { logs };
}

async function runIngestLoad() {
    const body = JSON.stringify(buildBatch(BATCH_SIZE));
    return autocannon({
        url: `${BASE_URL}/logs`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        duration: DURATION_SEC,
        connections: CONNECTIONS,
    });
}

async function runAggregateQueries(): Promise<number[]> {
    const latencies: number[] = [];
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const until = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const url = `${BASE_URL}/logs/aggregate?since=${since}&until=${until}&bucket=1h&group_by=service`;

    const endTime = Date.now() + DURATION_SEC * 1000;

    while (Date.now() < endTime) {
        const start = performance.now();
        try {
            const res = await fetch(url);
            await res.json();
            const elapsed = performance.now() - start;
            latencies.push(elapsed);
        } catch (err) {
            console.error("aggregate query failed:", err);
        }
        await new Promise((resolve) => setTimeout(resolve, 1000)); // one request per second
    }

    return latencies;
}

function percentile(sorted: number[], p: number): number {
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)]!;
}

async function main() {
    console.log(
        `\n=== Concurrent test: ingest (batch=${BATCH_SIZE}) + aggregate (1 req/sec) for ${DURATION_SEC}s ===\n`,
    );

    const [ingestResult, aggregateLatencies] = await Promise.all([
        runIngestLoad(),
        runAggregateQueries(),
    ]);

    const sorted = [...aggregateLatencies].sort((a, b) => a - b);

    console.log("\n=== Ingestion Results (while aggregate ran concurrently) ===");
    console.log(`Logs/sec (avg): ${(ingestResult.requests.average * BATCH_SIZE).toFixed(1)}`);
    console.log(`Ingest latency p95: ${ingestResult.latency.p97_5}ms`);
    console.log(`Errors: ${ingestResult.errors}`);

    console.log("\n=== Aggregate Query Results (while ingestion ran concurrently) ===");
    console.log(`Total aggregate queries: ${sorted.length}`);
    console.log(`Latency p50: ${percentile(sorted, 50).toFixed(1)}ms`);
    console.log(`Latency p95: ${percentile(sorted, 95).toFixed(1)}ms`);
    console.log(`Latency p99: ${percentile(sorted, 99).toFixed(1)}ms`);
    console.log(`Max: ${Math.max(...sorted).toFixed(1)}ms`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});