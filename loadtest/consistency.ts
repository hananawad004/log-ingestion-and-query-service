import autocannon from "autocannon";

const BASE_URL = process.env.TARGET_BASE_URL ?? "http://localhost:8080";
const DURATION_SEC = Number(process.env.DURATION_SEC ?? 20);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 17);

function randomLevel(): string {
    const levels = ["debug", "info", "warn", "error"];
    return levels[Math.floor(Math.random() * levels.length)]!;
}

async function runIngestLoad() {
    const logs = [];
    for (let i = 0; i < 100; i++) {
        logs.push({
            timestamp: new Date().toISOString(),
            level: randomLevel(),
            service: "checkout",
            message: `consistency test ${Math.random().toString(36).slice(2)}`,
            attributes: { request_id: Math.random().toString(36).slice(2) },
        });
    }
    const body = JSON.stringify({ logs });

    return autocannon({
        url: `${BASE_URL}/logs`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        duration: DURATION_SEC,
        connections: CONNECTIONS,
    });
}

async function runReadAfterWriteChecks(): Promise<{ ok: number; missing: number; latencies: number[] }> {
    let ok = 0;
    let missing = 0;
    const latencies: number[] = [];
    const endTime = Date.now() + DURATION_SEC * 1000;

    while (Date.now() < endTime) {
        const requestId = Math.random().toString(36).slice(2);

        const writeStart = performance.now();
        const writeRes = await fetch(`${BASE_URL}/logs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                logs: [
                    {
                        timestamp: new Date().toISOString(),
                        level: "info",
                        service: "checkout",
                        message: "read-after-write probe",
                        attributes: { request_id: requestId },
                    },
                ],
            }),
        });
        await writeRes.json();

        const readRes = await fetch(`${BASE_URL}/logs?attr.request_id=${requestId}`);
        const readBody = (await readRes.json()) as { logs: unknown[] };
        const elapsed = performance.now() - writeStart;
        latencies.push(elapsed);

        if (readBody.logs.length > 0) {
            ok++;
        } else {
            missing++;
        }

        await new Promise((r) => setTimeout(r, 200));
    }

    return { ok, missing, latencies };
}

function percentile(sorted: number[], p: number): number {
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)]!;
}

async function main() {
    console.log(`\n=== Read-after-write consistency test under concurrent ingestion ===\n`);

    const [ingestResult, checkResult] = await Promise.all([
        runIngestLoad(),
        runReadAfterWriteChecks(),
    ]);

    const sorted = [...checkResult.latencies].sort((a, b) => a - b);
    const total = checkResult.ok + checkResult.missing;

    console.log("=== Background Ingestion ===");
    console.log(`Logs/sec (avg): ${(ingestResult.requests.average * 100).toFixed(1)}`);
    console.log(`Errors: ${ingestResult.errors}`);

    console.log("\n=== Read-After-Write Checks ===");
    console.log(`Total checks: ${total}`);
    console.log(`Success (found immediately): ${checkResult.ok} (${((checkResult.ok / total) * 100).toFixed(1)}%)`);
    console.log(`Missing: ${checkResult.missing}`);
    console.log(`Write+Read latency p50: ${percentile(sorted, 50).toFixed(1)}ms`);
    console.log(`Write+Read latency p95: ${percentile(sorted, 95).toFixed(1)}ms`);
    console.log(`Max: ${Math.max(...sorted).toFixed(1)}ms`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});