# Pulse demo backend

This backend provides two PostgreSQL variants for a performance demo:

- PostgreSQL classic (`DB_MODE=plain`)
- PostgreSQL + TimescaleDB (`DB_MODE=timescale`)

The API is the same in both cases, so the frontend can switch between them without changing the UI contract.

## Run with Docker Compose

From the project root:

```bash
docker compose up -d --build
```

This starts:

- `postgres-plain` on port `5433`
- `postgres-timescale` on port `5434`
- `api-plain` on port `4001`
- `api-timescale` on port `4002`

## Endpoints

- `GET http://localhost:4001/health`
- `GET http://localhost:4001/api/config`
- `GET http://localhost:4001/api/overview`
- `GET http://localhost:4001/api/dashboard?range=5m`
- `GET http://localhost:4001/api/events` (Server-Sent Events; emits `readings-inserted` after each successful insert)
- `GET http://localhost:4001/api/series?metric=temperature&window=10m`
- `GET http://localhost:4001/api/alerts`
- `GET http://localhost:4001/api/queries/performance`

Similarly for the Timescale backend on `http://localhost:4002`.

The dashboard endpoint returns readings and aggregates queried from the database
selected by `DB_MODE`, along with the last reading timestamp. The current
dashboard does not display total-row, rows-per-second, active-sensor, or chunk
count statistic cards.

The `/api/queries/performance` endpoint runs each benchmark with
`EXPLAIN (ANALYZE, FORMAT JSON)` and reports the database engine's `Execution
Time` in milliseconds. This is internal execution time, not end-to-end HTTP
response time. `EXPLAIN ANALYZE` executes the query and returns its plan rather
than the query's result rows. The PostgreSQL and TimescaleDB benchmark SQL is
similar but not identical, so results are indicative rather than a strictly
like-for-like comparison.

The Docker Compose simulators insert matching deterministic batches on shared
2-second clock boundaries by default (`SIMULATOR_INTERVAL_MS` must match for
both APIs). Each batch contains 2,500 rows and uses its timestamp as the random
seed, so values and timestamps match in both databases while both services are
running. A batch can be missing from one database if its API or database is
unavailable at that boundary. The dashboard listens for `readings-inserted`
events from each API and reloads that database's readings as soon as a batch is
stored, without polling for new data. It limits summary and heatmap queries to
recent readings. Performance benchmarks are refreshed every 30 seconds.

## Local run without Docker

```bash
cd backend
cp .env.example .env
npm install
npm run dev
```

For the Timescale mode, set:

```bash
DB_MODE=timescale
DB_PORT=5434
DB_NAME=pulse_timescale
```

For the plain mode:

```bash
DB_MODE=plain
DB_PORT=5433
DB_NAME=pulse_plain
```

## Database schema

The demo inserts time-series readings into `sensor_readings` using a single table with timestamp + sensor metadata + aggregated metrics.

- Standard PostgreSQL mode acts as the baseline.
- Timescale mode enables `timescaledb` and converts the table into a hypertable using `create_hypertable`.
- `backend/sql/init-timescale.sql` enables compression, uses 5-minute chunks, and installs a policy for chunks older than 5 minutes.

The SQL initialization files run only when PostgreSQL initializes an empty data volume. On API startup, `ensureSchema()` in `src/db.ts` ensures the extension, table, hypertable, and indexes exist, but does not configure the compression policy. This is enough to demonstrate the difference in time-window queries and storage on temporal datasets.
