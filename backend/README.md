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
- `GET http://localhost:4001/api/series?metric=temperature&window=10m`
- `GET http://localhost:4001/api/alerts`
- `GET http://localhost:4001/api/queries/performance`

Similarly for the Timescale backend on `http://localhost:4002`.

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

The PostgreSQL API runs the single telemetry simulator and writes each generated batch to both databases. Each row contains temperature, humidity, CPU, memory, network, and estimated energy in kWh for one sensor every 250 ms. TimescaleDB uses a 10-minute hypertable chunk interval; PostgreSQL classic uses a regular table. Comparison endpoints select only `source = 'shared-simulator'` rows and align time-window boundaries so both engines count the same sample set.

The performance endpoint compares the same three per-sensor, per-second analytical results on shared telemetry over the same finalized three-minute window. The frontend sends one reference timestamp to both APIs so the comparison uses identical bounds. PostgreSQL aggregates raw rows using its time index; TimescaleDB reads a 1-second continuous aggregate, a native optimization for repeated time-series rollups. The aggregate refreshes every minute with a two-minute end offset. Both paths return equivalent bucket groups in the same order with a 50,000-row limit. Each workload gets one warm-up and two measured `EXPLAIN ANALYZE` executions; the endpoint returns results only when all three executions report exactly 50,000 rows, otherwise it returns HTTP 503 with the observed count. The reported metric is read-query latency and excludes ingest and aggregate-refresh cost, so it does not represent total system cost. The simulator writes the same synthetic telemetry to both databases. Results depend on hardware and load and demonstrate this query pattern, not universal TimescaleDB superiority.

This is enough to demonstrate the difference in time-window queries and performance on large temporal datasets.
