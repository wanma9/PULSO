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

The performance endpoint warms up each workload, averages two timed runs, and returns only the row count to avoid transferring unused query results to Node. It compares matching time windows and bucket sizes: temperature per district every second, per-sensor CPU/network peaks every minute, and district energy every 2 seconds, yielding around 10,000 rows per query. TimescaleDB reads historical buckets from continuous aggregates and the newest minute from the hypertable; classic PostgreSQL computes the same result from the raw table using `date_bin`. Refresh policies keep aggregates current for the configured retention period. Results are hardware- and cache-dependent, so TimescaleDB is not expected to win every workload.

This is enough to demonstrate the difference in time-window queries and performance on large temporal datasets.
