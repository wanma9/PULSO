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

The demo inserts time-series readings into `sensor_readings` using a single table with timestamp + sensor metadata + aggregated metrics.

- Standard PostgreSQL mode acts as the baseline.
- Timescale mode enables `timescaledb` and converts the table into a hypertable using `create_hypertable`.

This is enough to demonstrate the difference in time-window queries and performance on large temporal datasets.
