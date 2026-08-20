# Log Ingestion and Query Service

A high-throughput log ingestion, query, and retention service backed by PostgreSQL — a simplified Datadog/Loki-style log platform, built as a final project.

**Official benchmark result: 87.32/100 (Rank #10)** — Performance 44.85/50, Reliability 20/20, Correctness 15/15, Queries 7.47/15. See [Load-Test Methodology](#load-test-methodology-and-measured-performance) for the full investigation, including one optimization attempt that was measured, found to regress the score, and reverted.

## Table of Contents

- [Project Structure](#project-structure)
- [Setup and Usage](#setup-and-usage)
- [API Documentation](#api-documentation)
- [Schema and Index Design](#schema-and-index-design)
- [Attribute Storage Strategy](#attribute-storage-strategy)
- [Retention Strategy](#retention-strategy)
- [Rollup Table (Fast Aggregates)](#rollup-table-fast-aggregates)
- [Optional Features](#optional-features)
- [Testing](#testing)
- [CI Pipeline](#ci-pipeline)
- [Load-Test Methodology and Measured Performance](#load-test-methodology-and-measured-performance)
- [Known Limitations](#known-limitations)

---

## Project Structure

```
src/
├── index.ts              # Server bootstrap: run migrations → apply optional
│                          # indexes → start retention + rollup-flush
│                          # schedulers → listen
├── config.ts              # Central place that reads all environment variables
├── db/
│   ├── pool.ts             # Two connection pools: `pool` (writes) and
│   │                        # `readPool` (reads) — see Load-Test section
│   ├── migrate.ts          # Applies migrations/*.sql, tracked in
│   │                        # schema_migrations, skips already-applied ones
│   └── optionalIndexes.ts  # Creates/drops the optional message-search index
│                            # based on ENABLE_MESSAGE_SEARCH_INDEX
├── domain/
│   ├── logEntry.ts         # Core types: LogLevel, Attributes, LogEntry
│   └── errors.ts           # ValidationError, InvalidCursorError
├── validation/
│   └── logValidator.ts     # Per-entry validation rules, pure functions
├── repositories/
│   ├── logRepository.ts       # Bulk insert via unnest() — the only place
│   │                            # that writes to the `logs` table; also
│   │                            # records rollup deltas (see below)
│   └── partitionRepository.ts # Creates/drops monthly partitions
├── services/
│   ├── ingestService.ts    # Validates a batch, collects accepted/rejected
│   ├── queryService.ts     # Builds dynamic, parameterized WHERE clauses
│   │                        # for GET /logs + cursor pagination
│   ├── aggregateService.ts # Time-bucketing + group_by for GET /logs/aggregate;
│   │                        # reads from the rollup table when possible
│   ├── rollupBuffer.ts     # In-memory buffer for the 1-minute rollup table,
│   │                        # flushed to PostgreSQL periodically
│   └── retentionService.ts # Scheduled partition maintenance
├── http/
│   ├── routes.ts           # Maps each endpoint to its handler
│   └── handlers.ts         # Thin HTTP layer: parse request → call service
│                            # → map result/errors to status codes
└── utils/
└── cursor.ts            # base64url encode/decode for opaque pagination
# cursors, with full round-trip validation

migrations/          # SQL migrations, applied in order and tracked
test/                # Unit tests (see Testing)
loadtest/            # Load-testing and data-seeding scripts (see below)
```

**Why this structure:** HTTP handlers never contain SQL or business logic — they parse a request, call a service, and translate the result (or a thrown `ValidationError`/`InvalidCursorError`) into an HTTP response. Services never talk to Fastify. Repositories are the only files that contain raw SQL.

---

## Setup and Usage

### Requirements
- Docker and Docker Compose (v2, i.e. `docker compose`, not the legacy `docker-compose`)

### Start the service

```bash
docker compose up
```

This single command:
1. Starts a PostgreSQL 16 container (1 CPU / 1GB RAM limit)
2. Builds and starts the application container (0.5 CPU / 256MB RAM limit)
3. Runs database migrations automatically on startup
4. Exposes the API on `localhost:8080`

No manual configuration, `.env` file, or extra steps are required — this is the default, zero-configuration setup the load generator is graded against.

### Verify it's running

```bash
curl http://localhost:8080/health
```

### Local development (without Docker)

```bash
npm install
npm run dev
```

Requires `PGHOST`, `PGPORT`, etc. pointed at a running PostgreSQL instance (see `.env.example`).

### Running tests

```bash
npm test
```

---

## API Documentation

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Returns 200 once DB is connected, migrations applied, and the service is ready |
| `POST` | `/logs` | Ingests a batch of log entries with per-entry validation |
| `GET` | `/logs` | Queries logs with combinable filters and cursor pagination |
| `GET` | `/logs/aggregate` | Time-bucketed counts, optionally grouped by `service` or `level` |

### POST /logs

Accepts `{ "logs": [...] }`. Invalid entries are rejected individually without failing the whole batch:

```json
{
  "accepted": 9,
  "rejected": [
    { "index": 3, "reason": "invalid level: 'critical'" }
  ]
}
```

Returns `200` if at least one entry is accepted, `400` if all entries are rejected or the request is malformed.

### GET /logs

Supports `service`, `level`, `since`, `until`, `attr.<key>`, `q` (substring match on message), `limit` (default 100, max 1000), and `cursor` (opaque, base64url-encoded). Results are sorted by `timestamp DESC`, with `id` as a tiebreaker for deterministic ordering.

### GET /logs/aggregate

Requires `since`, `until`, and `bucket` (`1m`, `5m`, `1h`, or `1d`). Optional `group_by` (`service` or `level`). Same filters as `GET /logs` are supported.

---

## Schema and Index Design

The `logs` table is **range-partitioned by month** on the `ts` column:

```sql
CREATE TABLE logs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY,
    ts            TIMESTAMPTZ NOT NULL,
    level         TEXT NOT NULL,
    service       TEXT NOT NULL,
    message       TEXT NOT NULL,
    attributes    JSONB NOT NULL DEFAULT '{}'::jsonb,
    attributes_str JSONB GENERATED ALWAYS AS (jsonb_stringify_values(attributes)) STORED,
    PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
```

**Why partitioning:** with ~1M rows representing roughly a month of data, partitioning keeps each partition's indexes small (better cache locality inside a 1GB PostgreSQL container), and turns retention into a metadata-only `DROP TABLE` instead of a row-by-row `DELETE`.

### Indexes (created on the partitioned parent table, automatically propagated to every partition)

| Index | Purpose |
|---|---|
| `(ts DESC, id DESC)` | Primary access pattern (most-recent-first) and keyset/cursor pagination |
| `service` (btree) | Exact-match filter used on nearly every query |
| `level` (btree) | Exact-match filter |
| `attributes_str` (GIN, `jsonb_path_ops`) | Attribute equality lookups via containment (`@>`) — see Attribute Storage Strategy |

An earlier GIN index on the raw `attributes` column was dropped once `attr.*` filtering moved to `attributes_str`: it was still maintained on every insert but had zero read usage.

### Why `id` and `ts` together as primary key

Declarative partitioning in PostgreSQL requires the partition key (`ts`) to be part of any unique/primary key, so `(id, ts)` is the primary key rather than `id` alone.

---

## Attribute Storage Strategy

Attributes are stored as JSONB (`attributes`), preserving each value's original JSON type exactly as submitted — this is what `GET /logs` returns.

**The indexing problem and its solution:** the API contract requires `attr.<key>` equality to compare values *as strings* regardless of original type. The direct implementation, `attributes ->> key = value`, is correct but forces a scan — it's not an operation the GIN index on `attributes` can accelerate.

The fix: a **generated column**, `attributes_str`, stores every attribute value stringified, computed automatically by PostgreSQL on every insert via an `IMMUTABLE` SQL function. A GIN index (`jsonb_path_ops`) sits on `attributes_str`, so `attr.<key>` filters run as containment lookups instead of scans — while the original `attributes` column, and every API response, keeps original JSON types untouched.

**Why JSONB over EAV:** the attribute schema is genuinely dynamic. An EAV table would require a join per query and be several times larger than `logs` itself at 1M+ rows.

---

## Retention Strategy

Retention is implemented entirely through **partition management**, not row deletion:

1. On a recurring interval (`RETENTION_INTERVAL_MS`, default 1 hour), the service ensures a partition exists for **every month touched by the retention window** — from `now - RETENTION_DAYS` through next month, not just the current month. (An earlier version only created partitions for "now" and "next month," which silently routed older data into the unindexed `logs_default` catch-all and measurably slowed aggregate queries spanning that range — found via `EXPLAIN ANALYZE`, see Load-Test Methodology.)
2. Any partition whose entire date range has fully passed the retention window is dropped via `DROP TABLE`.
3. Partition metadata is tracked in a bookkeeping table (`log_partitions`).

**Granularity trade-off:** retention operates at monthly granularity, not exact-day — an accepted trade-off in exchange for retention being effectively free performance-wise.

Configuration: `RETENTION_DAYS` (default `30`), `RETENTION_INTERVAL_MS` (default `3600000`).

---

## Rollup Table (Fast Aggregates)

`GET /logs/aggregate` over a realistic full-month range initially had to scan and group nearly the entire `logs` table on every request — 2+ seconds, well above the 1-second p95 target even with correct indexes and tuned memory settings.

**Solution:** a pre-aggregated table, `logs_rollup_1m`, keyed on `(bucket_start, service, level)` with a running `count`. It's maintained **out-of-band** from the hot ingestion path: `insertBatch` records per-entry deltas into an in-memory buffer (`rollupBuffer.ts`), flushed to PostgreSQL in a single batched `UPSERT` on an interval (`ROLLUP_FLUSH_INTERVAL_MS`, default **500ms**) — not per insert. An earlier version updated the rollup inside the same transaction as every insert batch; under high concurrency this caused row-lock contention on the current-minute rollup rows and measurably hurt ingestion throughput, so it was moved to a buffered, periodic flush instead. The flush interval was tuned from an initial 1000ms down to 500ms after measuring a real improvement in aggregate latency (p95 54ms → 10ms in local benchmarking) with no regression elsewhere.

`aggregateLogs` reads from the rollup whenever the query has no `attr.*` or `q=` filter; such filtered queries fall back to scanning `logs` directly, unchanged.

**Trade-off:** rollup-backed aggregate counts can lag live ingestion by up to `ROLLUP_FLUSH_INTERVAL_MS`. On an unclean process crash, at most one flush interval's worth of increments can be lost from the rollup — the raw `logs` rows themselves are never affected.

---

## Optional Features

All optional features are **off by default** — `docker compose up` with no configuration always yields the plain core service.

### Message full-text search index

| Variable | Default | Effect |
|---|---|---|
| `ENABLE_MESSAGE_SEARCH_INDEX` | `false` | When `true`, creates a `pg_trgm` GIN index on `message` at startup, accelerating `q=` substring search |

Benchmarking showed this index costs roughly **35% of write throughput** under sustained load, so it's disabled by default.

---

## Testing

```bash
npm test
```

**`test/logValidator.test.ts`** — 14 tests covering per-entry validation rules and edge cases.

**`test/cursor.test.ts`** — 7 tests covering cursor encode/decode round-trips and rejection of malformed cursors.

**Additional manual/integration verification:** partial batch rejection, all-entries-rejected → 400, every `GET /logs` filter individually and in combination (including `attr.*` against both string- and number-typed stored values, confirming original JSON types are preserved in responses), `until <= since` → 400, malformed cursor → 400, empty result sets → `next_cursor: null`, required-field validation on `GET /logs/aggregate`.

---

## CI Pipeline

`.github/workflows/ci.yml` runs on every push and pull request to `main`:

1. **`build-and-test`** — installs dependencies, type-checks (`tsc --noEmit`), runs the unit test suite, builds the TypeScript output.
2. **`smoke-test`** — brings up the full stack with `docker compose up --build`, polls `/health`, then exercises all three data endpoints and fails the build if any doesn't return the expected status code.

---

## Load-Test Methodology and Measured Performance

### Test environment
- Docker Desktop on Windows, WSL2 (Ubuntu 24.04), Intel Core i7-1165G7 (4 physical cores)
- Application container: 0.5 CPU / 256MB RAM; PostgreSQL container: 1 CPU / 1GB RAM
- Load generation: custom `autocannon`-based scripts (`loadtest/ingest.ts`, `loadtest/concurrent.ts`, `loadtest/consistency.ts`, `loadtest/seed.ts`), plus a third-party benchmark CLI matching the official grading platform's methodology for local verification
- Dataset: 1,000,000 rows, timestamps spread randomly across a 30-day window, matching the "~1 month of data" spec assumption

### Methodology note

All numbers below were measured **after** seeding the full 1M-row dataset and running `ANALYZE`. Testing against an empty or unanalyzed table produced misleading query plans (stale statistics causing the planner to fall back to sequential scans) — a real pitfall worth documenting.

### Investigation summary (bottlenecks found and fixed, in the order discovered)

1. **Read query pool starvation.** `readPool` capped at `max: 2`, shared by every query endpoint. Raised to `max: 6`. Aggregate p50 under concurrent load: ~1,300–1,900ms → ~470ms.
2. **`attr.<key>` filtering not using any index.** Fixed via the `attributes_str` generated column + containment index.
3. **Data silently landing in the unoptimized `logs_default` partition.** The retention job only pre-created partitions for the current and next month. Confirmed via `EXPLAIN ANALYZE` (a full-month query included a costly `logs_default` scan, 3,365–4,697ms with the bug present). Fixed by covering every month in the retention window.
4. **`work_mem` too small for in-memory sorts at this data volume.** `EXPLAIN ANALYZE` showed disk-based external merge sorts. Raised `work_mem` to `32MB`. Query time: 3,721ms → 2,334ms.
5. **Full-table scan cost inherent to on-the-fly aggregation at 1M+ rows.** Solved with the rollup table (see above). Same query: ~2,334ms → ~10–70ms depending on flush interval.
6. **Dead index maintenance overhead.** Dropped the original `attributes` GIN index once reads moved to `attributes_str`.
7. **Backpressure attempted and reverted.** An in-flight-request-count limiter (503 shedding past a threshold) was added to address a suspected eventual-consistency issue under extreme sustained load, following advice in the spec that shedding load is legitimate. **Measured on the official grading platform, it made things worse**: total score dropped from 87.32 to 73.42, HTTP error rate rose from 0% to 0.63–1.80% across scenarios (503s appearing where there were none before), and eventual consistency success rate *decreased* in 3 of 4 scenarios rather than improving. It was reverted via `git revert`, restoring the 0%-error, 87.32-scoring behavior. This is included here deliberately: it's a genuine example of measuring an optimization against the real grading target, finding it regressed the result, and reversing course rather than keeping an unverified "improvement."
8. **Rollup flush interval tuned.** After reverting backpressure, `ROLLUP_FLUSH_INTERVAL_MS` was reduced from 1000ms to 500ms and re-measured locally: Queries score 14.0/15 → 14.8/15, aggregate p95 54ms → 10ms, with no regression in throughput, errors, or consistency — kept.

### Measured throughput

| Scenario | Result |
|---|---|
| Steady-state, batch size 100, 20 connections (local) | ~11,800–13,700 logs/sec |
| Steady-state, batch size 1,000, 50 connections (local) | ~26,500–27,200 logs/sec |
| Official platform — Load scenario (15,000 logs/s target, 120s) | 14,966.67 logs/sec, 0% errors |
| Official platform — Stress scenario (up to 30,000 logs/s) | 17,226.67 logs/sec |
| Official platform — Spike scenario (up to 30,000 logs/s) | 14,249.00 logs/sec |
| Official platform — Breakpoint scenario (up to 45,000 logs/s) | 17,360.00 logs/sec |
| Local benchmark CLI (post-revert, matched methodology) | 14,686–14,970 logs/sec, 0% errors |

### Aggregate query latency (after rollup table, flush interval 500ms)

| Configuration | Result |
|---|---|
| Local benchmark CLI, full scenario suite | aggregate p95 **10ms** |
| Concurrent with steady-state ingestion (custom script, 1 req/sec) | p50 ~48–98ms, p95 ~186–854ms |

**Target: aggregate p95 < 1 second while ingestion is active — met**, with substantial margin.

### Read-after-write consistency

At locally-achievable throughput (~11,000–13,000 logs/sec sustained), read-after-write checks succeeded **100%** of the time, with max write→read latency under 1.2 seconds. The local benchmark CLI's consistency check scored **4/4** across every configuration tested, including before, during, and after the backpressure experiment — indicating this particular check wasn't the differentiator in that regression (the HTTP error rate was).

### Retention performance

Partition drops (`DROP TABLE`) complete in well under a second regardless of partition size, since no row scanning is involved.

### A note on local benchmarking hardware variance

Early local benchmark runs, before diagnosing a CPU/memory resource-allocation issue on the test machine, reported "machine speed" as low as 0.18–0.20x a reference machine, making Performance/Queries numbers from those runs directionally useless (confirmed by the tool's own output warnings and by k6 itself failing to schedule thousands of load-generator iterations due to resource contention). After freeing up RAM, correcting `.wslconfig` CPU/memory allocation, and reverting an unrelated npm version change that had started blocking git-based package fetches, machine speed improved to 0.51–0.78x, and the resulting numbers (Performance 41–42/50, Queries 14–14.8/15, 0% errors) are treated as reliable local signal, cross-checked against the official platform score.

---

## Known Limitations

- **Rollup-backed aggregate counts can lag live ingestion by up to `ROLLUP_FLUSH_INTERVAL_MS` (default 500ms)**, and a small window of increments can be lost on an unclean process crash — the raw `logs` table is never affected.
- **`attr.*`/`q=`-filtered aggregate queries bypass the rollup fast path** and fall back to scanning `logs` directly.
- **`null` attribute values are rejected** — the spec's allowed types are string, number, boolean.
- **Retention operates at monthly granularity**, not exact-day.
- **No explicit backpressure/load-shedding is implemented.** One was built and measured on the official grading platform to regress overall score and eventual-consistency success rate, so it was reverted (see Load-Test Methodology, item 7). Under the officially measured throughput levels (up to 45,000 logs/sec in the breakpoint scenario), the service currently accepts and queues rather than shedding load explicitly.
- **`docker stats` occasionally reports CPU% slightly above the configured limit** in brief instantaneous snapshots — a known cgroup period-averaging characteristic, not an actual limit violation.
- **`autocannon` and related dev/test dependencies carry some `npm audit` warnings.** These don't ship in the production image (multi-stage build installs with `--omit=dev`).
```
