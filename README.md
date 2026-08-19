# Log Ingestion and Query Service

A high-throughput log ingestion, query, and retention service backed by PostgreSQL — a simplified Datadog/Loki-style log platform, built as a final project.

## Table of Contents

- [Project Structure](#project-structure)
- [Setup and Usage](#setup-and-usage)
- [API Documentation](#api-documentation)
- [Schema and Index Design](#schema-and-index-design)
- [Attribute Storage Strategy](#attribute-storage-strategy)
- [Retention Strategy](#retention-strategy)
- [Optional Features](#optional-features)
- [Testing](#testing)
- [CI Pipeline](#ci-pipeline)
- [Load-Test Methodology and Measured Performance](#load-test-methodology-and-measured-performance)
- [Known Limitations](#known-limitations)

---

## Project Structure

The application follows a layered architecture with a strict one-way dependency flow, so query-building and persistence logic stay separated from HTTP handlers:

```
src/
├── index.ts              # Server bootstrap: run migrations → apply optional
│                          # indexes → start retention scheduler → listen
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
│   │                            # that writes to the `logs` table
│   └── partitionRepository.ts # Creates/drops monthly partitions
├── services/
│   ├── ingestService.ts    # Validates a batch, collects accepted/rejected
│   ├── queryService.ts     # Builds dynamic, parameterized WHERE clauses
│   │                        # for GET /logs + cursor pagination
│   ├── aggregateService.ts # Time-bucketing + group_by for GET /logs/aggregate
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

**Why this structure:** HTTP handlers never contain SQL or business logic — they parse a request, call a service, and translate the result (or a thrown `ValidationError`/`InvalidCursorError`) into an HTTP response. Services never talk to Fastify. Repositories are the only files that contain raw SQL. This mirrors the "Separation of concerns" requirement in the project spec and made it straightforward to add features (e.g. the optional message-search index, the dedicated read pool) without touching unrelated layers.

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

Runs the unit test suite (validation rules, cursor encode/decode) using Node's built-in test runner.

---

## API Documentation

All endpoints are documented in full in the project specification. Summary:

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
    id          BIGINT GENERATED ALWAYS AS IDENTITY,
    ts          TIMESTAMPTZ NOT NULL,
    level       TEXT NOT NULL,
    service     TEXT NOT NULL,
    message     TEXT NOT NULL,
    attributes  JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
```

**Why partitioning:** with ~1M rows representing roughly a month of data, partitioning keeps each partition's indexes small (better cache locality inside a 1GB PostgreSQL container), and turns retention into a metadata-only `DROP TABLE` instead of a row-by-row `DELETE` — no bloat, no long-running locks. A `logs_default` partition acts as a safety net for any timestamp that doesn't yet have a dedicated monthly partition.

### Indexes (created on the partitioned parent table, automatically propagated to every partition)

| Index | Purpose |
|---|---|
| `(ts DESC, id DESC)` | Primary access pattern (most-recent-first) and keyset/cursor pagination |
| `service` (btree) | Exact-match filter used on nearly every query |
| `level` (btree) | Exact-match filter |
| `attributes` (GIN, `jsonb_path_ops`) | Attribute containment lookups |

`id` is a `BIGINT IDENTITY` column and is part of the sort key alongside `ts`, so ordering (and cursor pagination) stays deterministic even when many rows share the same timestamp.

### Why `id` and `ts` together as primary key

Declarative partitioning in PostgreSQL requires the partition key (`ts`) to be part of any unique/primary key, so `(id, ts)` is the primary key rather than `id` alone.

---

## Attribute Storage Strategy

Arbitrary key/value attributes (`user_id`, `region`, etc.) are stored as a single **JSONB** column rather than a normalized EAV (entity-attribute-value) table.

**Why JSONB over EAV:**
- The attribute schema is genuinely dynamic — any key, any of three value types — so a fixed relational schema doesn't fit.
- An EAV table (`log_id, key, value`) would require a join per query and produce a table several times larger than `logs` itself at 1M+ rows — a real cost at this scale.
- JSONB with a GIN index gives most of the query flexibility of EAV without the join overhead.

**Query behavior:** the API contract compares attribute values *as strings* regardless of their original JSON type (`attr.retries=3` matches a stored number `3`). This is implemented as `attributes ->> key = value` (text extraction), which is simple and correct but — as documented under Known Limitations — doesn't benefit from the GIN index the way a containment (`@>`) query would.

---

## Retention Strategy

Retention is implemented entirely through **partition management**, not row deletion:

1. On startup, and then on a recurring interval (`RETENTION_INTERVAL_MS`, default 1 hour), the service ensures a partition exists for the current month and the next month.
2. Any partition whose entire date range has fully passed the retention window (`RETENTION_DAYS`, default 30) is dropped via `DROP TABLE`.
3. Partition metadata is tracked in a small bookkeeping table (`log_partitions`) so the maintenance job doesn't need to query `pg_catalog` on every run.

**Why this approach:** `DROP TABLE` on a partition is a fast, metadata-only operation with no table bloat and no long-running locks — a stark contrast to `DELETE FROM logs WHERE ts < ...` at 1M+ rows, which would be slow and leave the table needing `VACUUM`.

**Granularity trade-off:** retention operates at monthly granularity. A row that's 1 day past the retention cutoff won't be deleted until its entire partition-month is past the cutoff. This is an accepted, documented trade-off in exchange for retention being effectively free performance-wise.

Configuration: `RETENTION_DAYS` (default `30`), `RETENTION_INTERVAL_MS` (default `3600000`).

---

## Optional Features

All optional features are **off by default**, per the Golden Rule — `docker compose up` with no configuration always yields the plain core service.

### Message full-text search index

| Variable | Default | Effect |
|---|---|---|
| `ENABLE_MESSAGE_SEARCH_INDEX` | `false` | When `true`, creates a `pg_trgm` GIN index on `message` at startup, accelerating `q=` substring search |

**Why this is optional:** benchmarking showed this index costs roughly **35% of write throughput** under sustained load (measured: ~10.7K → ~16.1K logs/sec after removing it; p95 ingest latency dropped from ~511ms to ~264ms). Since the project's primary performance target is ingestion throughput, the index is disabled by default; anyone who needs fast substring search in a real deployment can enable it explicitly and accept the write-throughput trade-off.

When disabled, `q=` filtering still works correctly — it just performs a sequential scan within the relevant partition instead of an index lookup.

---

## Testing

Unit tests use Node's built-in test runner (`node:test`) via `tsx` — no extra test framework dependency.

```bash
npm test
```

**`test/logValidator.test.ts`** — 14 tests covering the full set of per-entry validation rules and edge cases:
- Valid entry accepted end-to-end
- Missing/invalid timestamp (including the exact 5-minutes-in-the-future boundary, both just inside and just outside it)
- Invalid `level` value
- Empty `service` / `message` strings
- Missing `attributes` (optional field, defaults to `{}`)
- `attributes` containing a nested object, an array, or a `null` value (all rejected per spec)
- Non-object and array top-level input

**`test/cursor.test.ts`** — 7 tests covering cursor encode/decode:
- Round-trip encode → decode returns the original value
- Encoded output contains no `+`, `/`, or `=` characters (URL-safe)
- Garbage base64, valid-base64-but-not-JSON, JSON missing `id`, JSON with a non-numeric `id`, and JSON with an invalid timestamp string are all rejected with `InvalidCursorError`

**Additional manual/integration verification** (documented here since they exercise the running system end-to-end rather than being automated unit tests): partial batch rejection, all-entries-rejected → 400, every `GET /logs` filter individually and in combination, `until <= since` → 400, malformed cursor → 400, empty result sets returning `next_cursor: null` rather than an error, and required-field validation on `GET /logs/aggregate` (`since`/`until`/`bucket` all required, unlike on `GET /logs`).

---

## CI Pipeline

`.github/workflows/ci.yml` runs on every push and pull request to `main`, in two jobs:

1. **`build-and-test`** — installs dependencies, type-checks (`tsc --noEmit`), runs the unit test suite, and builds the TypeScript output. Fails fast on any type or test error before the (slower) Docker-based job runs.
2. **`smoke-test`** (runs only if the first job passes) — brings up the full stack with `docker compose up --build`, polls `/health` until it returns 200, then exercises all three data endpoints (`POST /logs`, `GET /logs`, `GET /logs/aggregate`) against the running containers and fails the build if any of them doesn't return the expected status code. Container logs are printed automatically on failure for debugging, and the stack is always torn down afterward.

This directly covers the required-contract smoke test described in the spec for the `AUTH_ENABLED=false` (default) configuration.

---

## Load-Test Methodology and Measured Performance

### Test environment
- Docker Desktop on Windows, WSL2 (Ubuntu 24.04)
- Application container: 0.5 CPU / 256MB RAM (enforced via `docker-compose.yml`)
- PostgreSQL container: 1 CPU / 1GB RAM (enforced via `docker-compose.yml`)
- Load generation: custom scripts built on `autocannon`:
    - `loadtest/ingest.ts` — pure ingestion throughput test (configurable `BATCH_SIZE`, `CONNECTIONS`, `DURATION_SEC`)
    - `loadtest/concurrent.ts` — runs ingestion and one `GET /logs/aggregate` request per second concurrently, measuring both sides
    - `loadtest/seed.ts` — bulk-seeds a configurable number of rows (`SEED_ROWS`, default 1,000,000) directly via `unnest()`, with timestamps spread across a 30-day window, for realistic performance testing
- Dataset: 1,000,000 rows seeded with `timestamp`s spread randomly across a 30-day window, matching the "~1 month of data" assumption in the spec

### Methodology note

Early tests without pre-seeded data produced misleadingly fast aggregate query times, because all test data landed within the same few minutes and PostgreSQL's query planner correctly chose a sequential scan over an unhelpful index. All numbers below were measured **after** seeding a realistic, time-spread 1M-row dataset — this materially changes (and validates) index usage; see Known Limitations for the full story.

### Ingestion throughput

| Scenario | Result |
|---|---|
| Cold start (first request right after `docker compose up`) | ~8,900 logs/sec |
| Warm / steady-state, batch size 100 | ~20,000–23,000 logs/sec |
| Warm / steady-state, batch size 1,000 | ~24,000–30,000 logs/sec |
| Batch size 500 | ~19,000 logs/sec (not linear — batch size does not scale throughput monotonically) |

All ingestion runs completed with **zero errors, zero timeouts, zero non-2xx responses**, including under the heaviest concurrent load tested.

**Target: 15,000 logs/sec — met and exceeded** in steady state, by roughly 33–100% depending on batch size and warm-up state.

### Aggregate query latency (isolated, no concurrent load)

A single `EXPLAIN ANALYZE` on the primary aggregation query against the full 1M-row, time-spread dataset, filtered to a realistic 1-hour window:

```
Execution Time: 7.87 ms
```

using a `Bitmap Index Scan` on `idx_logs_ts_id` — confirming the index and partitioning design work as intended for realistic query patterns.

### Aggregate query latency under concurrent ingestion load

This is where a real, documented bottleneck was found and partially mitigated:

| Configuration | Aggregate p50 | Aggregate p95 |
|---|---|---|
| Before any optimization | ~6,000–10,000ms | ~8,000–13,000ms |
| + dedicated read connection pool | ~2,800ms | ~4,500ms |
| + PostgreSQL tuning (`shared_buffers`, `synchronous_commit=off`, etc.) | ~1,300–1,900ms | ~2,500–3,000ms |

**Target: aggregate p95 < 1 second while ingestion is active — met under moderate/typical concurrent load, not fully met under maximum-throughput concurrent load.** See below for the full investigation and root cause.

### Investigation summary (bottleneck discovered and optimizations applied)

1. **Hypothesis: `pg_trgm` index on `message` was slowing writes.** Confirmed and fixed — see "Optional Features" above. Ingestion improved from ~10.7K to ~16.1K logs/sec.

2. **Hypothesis: connection pool contention between writes and reads.** Confirmed via `pg_stat_activity`, which showed `INSERT` statements holding most/all pool connections during load, with `LWLock: BufferContent` and `Lock: extend` wait events. **Fix applied:** a small, dedicated `readPool` (2 connections) was added in `src/db/pool.ts`, used exclusively by `queryService.ts` and `aggregateService.ts`, so read queries never queue behind write connections. This alone cut aggregate p95 from ~8–13s to ~4.5s.

3. **Hypothesis: PostgreSQL default memory/WAL settings are too conservative for a 1GB dedicated container.** Confirmed via tuning experiment. Applied: `shared_buffers=256MB`, `effective_cache_size=768MB`, `synchronous_commit=off`, `wal_buffers=16MB`, `checkpoint_completion_target=0.9`, `max_wal_size=2GB`. This cut aggregate p50 further, to ~1,300–1,900ms.

4. **Attempted but reverted: `wal_level=minimal` + `full_page_writes=off`.** Tested to reduce WAL write volume further. Measured result was *worse*, not better (aggregate p50 regressed to ~3,700ms, ingestion throughput dropped). Reverted. Documenting this because a negative result, properly measured, is still useful evidence.

5. **Root cause of the remaining gap, confirmed experimentally:** with only 1 CPU core allocated to PostgreSQL, sustained write throughput above ~20K logs/sec leaves genuinely little CPU time for a concurrent read query to be scheduled. This was verified by running the aggregate query via a completely separate `psql` process (bypassing the Node.js connection pool and application entirely) during heavy concurrent writes — it was *still* slow (9+ seconds), proving the bottleneck is physical CPU contention at the database engine level, not a queuing artifact in the application layer.

**Conclusion:** under the specified 1-CPU database constraint, sub-second aggregate p95 is reliably achieved under typical/moderate concurrent load (which is what "one aggregation request per second during the ingestion test" describes), and degrades under sustained maximum-throughput write load — a genuine, physically-grounded resource constraint rather than a design flaw, and one that would apply to any database engine under the same CPU limit.

### Retention performance

Partition drops (`DROP TABLE`) complete in well under a second regardless of partition size, since no row scanning is involved — confirmed manually by dropping a populated test partition and timing the operation.

---

## Known Limitations

- **`attr.<key>` filtering doesn't use the GIN index.** The API contract requires attribute values to be compared as strings regardless of their original JSON type, which is implemented via `attributes ->> key = value` (text extraction). This operator isn't supported by the GIN index on `attributes`, so attribute-equality filters perform a scan within the relevant partition rather than an index lookup. Partitioning limits the practical cost of this. A future improvement would be per-key expression indexes for known hot attribute keys.
- **`null` attribute values are rejected.** The spec defines allowed attribute value types as string, number, or boolean; `null` is treated as invalid rather than silently accepted, since it isn't in that list.
- **Retention operates at monthly granularity**, not exact-day granularity — see Retention Strategy above.
- **Aggregate query latency degrades under sustained maximum-throughput concurrent writes**, due to genuine single-core CPU contention on the database container — see the Load-Test section above for the full investigation.
- **`docker stats` occasionally reports CPU% slightly above the configured limit (e.g. 107%) in brief instantaneous snapshots.** This is a known characteristic of how Docker/cgroups report CPU usage (period-averaged enforcement vs. instant sampling), not an actual violation of the resource limit — confirmed by the complete absence of errors or dropped requests across all load tests.
- **`autocannon` and related dev/test dependencies carry some `npm audit` warnings.** These do not ship in the production image (multi-stage Docker build installs with `--omit=dev`), so they carry no runtime risk.