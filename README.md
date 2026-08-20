
# Log Ingestion and Query Service

A high-throughput log ingestion, query, and retention service backed by PostgreSQL — a simplified Datadog/Loki-style log platform, built as a final project.

**Official benchmark result: 87.32/100 (Rank #10)** — Performance 44.85/50, Reliability 20/20, Correctness 15/15, Queries 7.47/15.

## Table of Contents

- [Project Structure](#project-structure)
- [Setup and Usage](#setup-and-usage)
- [API Documentation](#api-documentation)
- [Schema and Index Design](#schema-and-index-design)
- [Attribute Storage Strategy](#attribute-storage-strategy)
- [Retention Strategy](#retention-strategy)
- [Rollup Table (Fast Aggregates)](#rollup-table-fast-aggregates)
- [Optional Features](#optional-features)
- [Overload Protection (Backpressure)](#overload-protection-backpressure)
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
│   │                        # flushed to PostgreSQL once per second
│   └── retentionService.ts # Scheduled partition maintenance
├── http/
│   ├── routes.ts           # Maps each endpoint to its handler
│   └── handlers.ts         # Thin HTTP layer: parse request → call service
│                            # → map result/errors to status codes;
│                            # also implements ingestion backpressure
└── utils/
└── cursor.ts            # base64url encode/decode for opaque pagination
# cursors, with full round-trip validation

migrations/          # SQL migrations, applied in order and tracked
test/                # Unit tests (see Testing)
loadtest/            # Load-testing and data-seeding scripts (see below)
```

**Why this structure:** HTTP handlers never contain SQL or business logic — they parse a request, call a service, and translate the result (or a thrown `ValidationError`/`InvalidCursorError`) into an HTTP response. Services never talk to Fastify. Repositories are the only files that contain raw SQL. This mirrors the "Separation of concerns" requirement in the project spec.

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

Returns `200` if at least one entry is accepted, `400` if all entries are rejected or the request is malformed, `503` (with `Retry-After`) if the service is at capacity — see [Overload Protection](#overload-protection-backpressure).

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

**Why partitioning:** with ~1M rows representing roughly a month of data, partitioning keeps each partition's indexes small (better cache locality inside a 1GB PostgreSQL container), and turns retention into a metadata-only `DROP TABLE` instead of a row-by-row `DELETE`. A `logs_default` partition acts as a safety net for any timestamp that doesn't yet have a dedicated monthly partition — see the note under Retention Strategy about why this partition must stay empty in practice.

### Indexes (created on the partitioned parent table, automatically propagated to every partition)

| Index | Purpose |
|---|---|
| `(ts DESC, id DESC)` | Primary access pattern (most-recent-first) and keyset/cursor pagination |
| `service` (btree) | Exact-match filter used on nearly every query |
| `level` (btree) | Exact-match filter |
| `attributes_str` (GIN, `jsonb_path_ops`) | Attribute equality lookups via containment (`@>`) — see Attribute Storage Strategy |

An earlier GIN index on the raw `attributes` column (`idx_logs_attributes_gin`) was **dropped** once `attr.*` filtering moved to `attributes_str`: it was still maintained on every insert but had zero read usage, so it was pure write overhead.

### Why `id` and `ts` together as primary key

Declarative partitioning in PostgreSQL requires the partition key (`ts`) to be part of any unique/primary key, so `(id, ts)` is the primary key rather than `id` alone.

---

## Attribute Storage Strategy

Arbitrary key/value attributes are stored as a JSONB column (`attributes`), preserving each value's original JSON type (string, number, boolean) exactly as submitted — this is what `GET /logs` returns.

**The indexing problem and its solution:** the API contract requires `attr.<key>` equality to compare values *as strings* regardless of original type (`attr.retries=3` must match a stored number `3`). The direct implementation, `attributes ->> key = value` (text extraction), is correct but isn't an operation the GIN index on `attributes` can accelerate — it forces a scan.

The fix: a **generated column**, `attributes_str`, stores every attribute value stringified (via an `IMMUTABLE` SQL function, `jsonb_stringify_values`), computed automatically by PostgreSQL on every insert. A GIN index (`jsonb_path_ops`) sits on `attributes_str`, so `attr.<key>` filters run as a containment lookup (`attributes_str @> '{"key":"value"}'`) instead of a scan — while the original `attributes` column, and therefore every API response, is completely unaffected and keeps original JSON types.

**Why JSONB (with this indexing layer) over EAV:** the attribute schema is genuinely dynamic — any key, any of three value types — so a fixed relational schema doesn't fit. An EAV table (`log_id, key, value`) would require a join per query and produce a table several times larger than `logs` itself at 1M+ rows.

---

## Retention Strategy

Retention is implemented entirely through **partition management**, not row deletion:

1. On a recurring interval (`RETENTION_INTERVAL_MS`, default 1 hour), the service ensures a partition exists for **every month touched by the retention window** — from `now - RETENTION_DAYS` through next month — not just the current month. (An earlier version only created partitions for "now" and "next month," which silently routed older seeded/ingested data into the unindexed-for-performance `logs_default` catch-all and measurably slowed aggregate queries spanning that range; this was found and fixed via `EXPLAIN ANALYZE` — see Load-Test Methodology.)
2. Any partition whose entire date range has fully passed the retention window (`RETENTION_DAYS`, default 30) is dropped via `DROP TABLE`.
3. Partition metadata is tracked in a bookkeeping table (`log_partitions`).

**Granularity trade-off:** retention operates at monthly granularity, not exact-day. Accepted trade-off in exchange for retention being effectively free performance-wise.

Configuration: `RETENTION_DAYS` (default `30`), `RETENTION_INTERVAL_MS` (default `3600000`).

---

## Rollup Table (Fast Aggregates)

`GET /logs/aggregate` over a realistic full-month range initially had to scan and group nearly the entire `logs` table (~1M rows) on every request — even with correct indexes and tuned memory settings, this took 2–4+ seconds, well above the 1-second p95 target.

**Solution:** a small pre-aggregated table, `logs_rollup_1m`, keyed on `(bucket_start, service, level)` with a running `count`. It's maintained **out-of-band** from the hot ingestion path: `insertBatch` records per-entry deltas into an in-memory buffer (`rollupBuffer.ts`), which is flushed to PostgreSQL in a single batched `UPSERT` once per second (`ROLLUP_FLUSH_INTERVAL_MS`, default 1000ms) — not per insert. An earlier version updated the rollup inside the same transaction as every insert batch; under high concurrency this caused row-lock contention on the current-minute rollup rows and measurably hurt ingestion throughput, so it was moved to a buffered, periodic flush instead.

`aggregateLogs` reads from the rollup whenever the query has no `attr.*` or `q=` filter (the common case, since the rollup has no attribute/message data to filter on); such filtered queries fall back to scanning `logs` directly, unchanged.

**Trade-off (documented, not hidden):** rollup-backed aggregate counts can lag live ingestion by up to `ROLLUP_FLUSH_INTERVAL_MS`. On an unclean process crash, at most one flush interval's worth of increments can be lost from the rollup — the raw `logs` rows themselves are never affected, since they're inserted and committed independently.

---

## Optional Features

All optional features are **off by default** — `docker compose up` with no configuration always yields the plain core service.

### Message full-text search index

| Variable | Default | Effect |
|---|---|---|
| `ENABLE_MESSAGE_SEARCH_INDEX` | `false` | When `true`, creates a `pg_trgm` GIN index on `message` at startup, accelerating `q=` substring search |

Benchmarking showed this index costs roughly **35% of write throughput** under sustained load, so it's disabled by default. When disabled, `q=` still works correctly via sequential scan within the relevant partition.

---

## Overload Protection (Backpressure)

| Variable | Default | Effect |
|---|---|---|
| `MAX_CONCURRENT_INGESTS` | `100` | Maximum concurrent in-flight `POST /logs` requests before new ones are shed |

Once `MAX_CONCURRENT_INGESTS` concurrent ingestion requests are being processed, additional requests are rejected immediately with `503` + `Retry-After: 1`, rather than being accepted and left queuing indefinitely.

**Why:** under sustained write throughput far beyond the single-core PostgreSQL container's capacity, unbounded queuing lets the application accept (200 OK) far more than it can durably commit and make visible in a timely manner — producing "accepted but not yet visible" records, which is exactly what surfaced as Eventual Consistency failures during testing at extreme sustained load (30,000–45,000 logs/sec). Shedding excess load explicitly is the behavior the project spec itself calls out as legitimate: *"shedding load with 429 or 503 plus Retry-After is better than crashing."* The threshold is set well above the 15,000 logs/sec baseline target and above every locally-measured steady-state throughput (up to ~27,000 logs/sec), so it only engages during genuine overload, not normal operation.

---

## Testing

```bash
npm test
```

**`test/logValidator.test.ts`** — 14 tests covering per-entry validation rules and edge cases (timestamp boundaries, invalid level, empty strings, nested/array/null attributes, non-object/array top-level input).

**`test/cursor.test.ts`** — 7 tests covering cursor encode/decode round-trips and rejection of malformed cursors.

**Additional manual/integration verification:** partial batch rejection, all-entries-rejected → 400, every `GET /logs` filter individually and in combination (including `attr.*` against both string- and number-typed stored values), `until <= since` → 400, malformed cursor → 400, empty result sets → `next_cursor: null`, required-field validation on `GET /logs/aggregate`, and `attributes` in API responses preserving original JSON types after the `attributes_str` indexing change.

---

## CI Pipeline

`.github/workflows/ci.yml` runs on every push and pull request to `main`:

1. **`build-and-test`** — installs dependencies, type-checks (`tsc --noEmit`), runs the unit test suite, builds the TypeScript output.
2. **`smoke-test`** — brings up the full stack with `docker compose up --build`, polls `/health`, then exercises all three data endpoints and fails the build if any doesn't return the expected status code.

---

## Load-Test Methodology and Measured Performance

### Test environment
- Docker Desktop on Windows, WSL2 (Ubuntu 24.04)
- Application container: 0.5 CPU / 256MB RAM; PostgreSQL container: 1 CPU / 1GB RAM (both enforced via `docker-compose.yml`)
- Load generation: custom scripts on `autocannon` (`loadtest/ingest.ts`, `loadtest/concurrent.ts`, `loadtest/consistency.ts`), plus `loadtest/seed.ts` for bulk-seeding
- Dataset: 1,000,000 rows, timestamps spread randomly across a 30-day window, matching the "~1 month of data" spec assumption

### Methodology note

All numbers below were measured **after** seeding the full 1M-row, time-spread dataset and running `ANALYZE`. Testing against an empty or freshly-seeded-but-unanalyzed table produced misleading query plans (PostgreSQL's planner falling back to sequential scans due to stale statistics) — a real pitfall documented here because it cost real debugging time.

### Investigation summary (bottlenecks discovered and fixed, in order found)

1. **Read query pool starvation.** `readPool` was capped at `max: 2`, shared by every `GET /logs` and `GET /logs/aggregate` call — concurrent query load queued behind it regardless of database headroom. Raised to `max: 6`. Aggregate p50 under concurrent load: ~1,300–1,900ms → ~470ms.
2. **`attr.<key>` filtering not using any index.** `attributes ->> key = value` isn't GIN-indexable. Fixed via the `attributes_str` generated column + containment index — see Attribute Storage Strategy.
3. **Data silently landing in the unoptimized `logs_default` partition.** `retentionService` only pre-created partitions for the current and next month, so seeded data from the prior month fell into `logs_default`. A full-month aggregate query went from an efficient `Index Only Scan` per partition to including a costly scan of `logs_default` — confirmed via `EXPLAIN ANALYZE` (query time 3,365–4,697ms with the bug present). Fixed by covering every month in the retention window.
4. **`work_mem` too small for in-memory sorts at this data volume.** `EXPLAIN ANALYZE` showed `Sort Method: external merge Disk` (disk-based sort) on the aggregate query. Raised `work_mem` to `32MB`; sort moved to `quicksort` in memory. Query time: 3,721ms → 2,334ms.
5. **Full-table scan cost inherent to on-the-fly aggregation at 1M+ rows.** Even after 1–4, a full-month aggregate query still had to scan and group ~1M rows (~2.3s). Solved architecturally with a pre-aggregated rollup table — see [Rollup Table](#rollup-table-fast-aggregates). Same query after: **~36–70ms** (from ~2,334ms — roughly a 98% reduction).
6. **Dead index maintenance overhead.** The original `attributes` GIN index (`idx_logs_attributes_gin`) had zero read usage after `attr.*` moved to `attributes_str`, but was still updated on every insert. Dropped.
7. **Eventual consistency failures under extreme sustained load (30,000–45,000 logs/sec, observed via the official grading platform, not reproducible with this project's local single-machine tooling).** Root cause: unbounded request queuing let the application accept far more writes than it could durably commit and make visible within the platform's consistency-check window. Addressed with explicit backpressure — see [Overload Protection](#overload-protection-backpressure). Not independently re-verified against the same extreme-load scenario locally (see Known Limitations); the official grading platform's next run is the authoritative check.

### Measured throughput (after all fixes above)

| Scenario | Result |
|---|---|
| Steady-state, batch size 100, 20 connections | ~11,800–13,700 logs/sec |
| Steady-state, batch size 1,000, 50 connections | ~26,500–27,200 logs/sec |
| Official platform — Load scenario (15,000 logs/s target, 120s) | 14,966.67 logs/sec |
| Official platform — Stress scenario (up to 30,000 logs/s) | 17,226.67 logs/sec |
| Official platform — Spike scenario (up to 30,000 logs/s) | 14,249.00 logs/sec |
| Official platform — Breakpoint scenario (up to 45,000 logs/s) | 17,360.00 logs/sec |

All local ingestion runs completed with zero errors and zero timeouts; observed non-2xx responses at very high local concurrency were confirmed (via targeted logging) to be intentional `503`s from the backpressure mechanism, not failures.

### Aggregate query latency (after rollup table)

| Configuration | Aggregate p50 | Aggregate p95 |
|---|---|---|
| Isolated, single query, full-month range | — | ~36–70ms |
| Concurrent with steady-state ingestion (1 req/sec) | ~48–98ms | ~186–854ms |

**Target: aggregate p95 < 1 second while ingestion is active — met**, with substantial margin, after the rollup table fix.

### Read-after-write consistency (local)

At locally-achievable throughput (~11,000–13,000 logs/sec sustained), read-after-write checks succeeded **100%** of the time, with max write→read latency under 1.2 seconds — well inside the 20-second requirement. This is measured at a lower throughput than the official platform's stress/breakpoint scenarios (up to 45,000 logs/sec); see Known Limitations for why that gap couldn't be closed with this project's local tooling.

### Retention performance

Partition drops (`DROP TABLE`) complete in well under a second regardless of partition size, since no row scanning is involved.

---

## Known Limitations

- **Local load-testing tooling cannot reproduce the platform's highest-throughput scenarios.** Local `autocannon`-based scripts, run from a single WSL2/Docker Desktop machine, top out around 27,000 logs/sec before the client itself (not the service) becomes the bottleneck. The official grading platform's Stress/Spike/Breakpoint scenarios push to 22,500–45,000 logs/sec — a range where a real Eventual Consistency issue was found and addressed (see Overload Protection), but which can't be independently re-verified end-to-end on local hardware. The next official platform run is the authoritative check for this fix.
- **Rollup-backed aggregate counts can lag live ingestion by up to `ROLLUP_FLUSH_INTERVAL_MS` (default 1s)**, and a small window of increments can be lost on an unclean process crash — the raw `logs` table is never affected. See [Rollup Table](#rollup-table-fast-aggregates).
- **`attr.*`/`q=`-filtered aggregate queries bypass the rollup fast path** and fall back to scanning `logs` directly, since the rollup only tracks `(minute, service, level)` counts.
- **`null` attribute values are rejected** — the spec's allowed types are string, number, boolean, and `null` isn't among them.
- **Retention operates at monthly granularity**, not exact-day.
- **`docker stats` occasionally reports CPU% slightly above the configured limit** (e.g. 105–107%) in brief instantaneous snapshots — a known cgroup period-averaging characteristic, not an actual limit violation (no errors or dropped requests were observed across any load test at this level).
- **`autocannon` and related dev/test dependencies carry some `npm audit` warnings.** These don't ship in the production image (multi-stage build installs with `--omit=dev`).
```

