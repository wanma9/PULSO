import pg, { type PoolConfig } from "pg";
import dotenv from "dotenv";

dotenv.config();

export type DbMode = "plain" | "timescale";

export const dbMode: DbMode = process.env.DB_MODE === "timescale" ? "timescale" : "plain";
const retentionHours = Math.max(1, Number(process.env.DATA_RETENTION_HOURS ?? 1));
const aggregateRefreshHours = Math.ceil(retentionHours) + 1;

const dbConfig: PoolConfig = {
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? (dbMode === "timescale" ? 5434 : 5433)),
  user: process.env.DB_USER ?? "pulse",
  password: process.env.DB_PASSWORD ?? "pulse",
  database: process.env.DB_NAME ?? (dbMode === "timescale" ? "pulse_timescale" : "pulse_plain"),
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
};

export const pool = new pg.Pool(dbConfig);
const peerPool =
  dbMode === "plain" && process.env.DB_PEER_HOST
    ? new pg.Pool({
        ...dbConfig,
        host: process.env.DB_PEER_HOST,
        port: Number(process.env.DB_PEER_PORT ?? 5432),
        database: process.env.DB_PEER_NAME ?? "pulse_timescale",
      })
    : null;

export async function ensureSchema() {
  if (dbMode === "timescale") {
    await pool.query("CREATE EXTENSION IF NOT EXISTS timescaledb;");
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sensor_readings (
      ts TIMESTAMPTZ NOT NULL,
      sensor_id TEXT NOT NULL,
      district TEXT NOT NULL,
      metric TEXT NOT NULL,
      temperature DOUBLE PRECISION,
      humidity DOUBLE PRECISION,
      cpu DOUBLE PRECISION,
      memory DOUBLE PRECISION,
      network DOUBLE PRECISION,
      value DOUBLE PRECISION,
      energy_kwh DOUBLE PRECISION,
      source TEXT NOT NULL DEFAULT 'simulator',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  if (dbMode === "timescale") {
    await pool.query(`
      SELECT create_hypertable(
        'sensor_readings',
        'ts',
        chunk_time_interval => INTERVAL '10 minutes',
        if_not_exists => TRUE
      );
    `);
    await pool.query(`
      SELECT set_chunk_time_interval('sensor_readings', INTERVAL '10 minutes');
    `);
    await pool.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_2s
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('2 seconds', ts, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket,
        district,
        AVG(temperature) AS avg_temperature
      FROM sensor_readings
      WHERE metric = 'telemetry'
      GROUP BY bucket, district
      WITH DATA;
    `);
    await pool.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_1s
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('1 second', ts, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket,
        district,
        AVG(temperature) AS avg_temperature
      FROM sensor_readings
      WHERE metric = 'telemetry'
      GROUP BY bucket, district
      WITH DATA;
    `);
    await pool.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS shared_telemetry_1s
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('1 second', ts, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket,
        district,
        AVG(temperature) AS avg_temperature
      FROM sensor_readings
      WHERE metric = 'telemetry' AND source = 'shared-simulator'
      GROUP BY bucket, district
      WITH DATA;
    `);
    await pool.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_peaks_1m
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('1 minute', ts, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket,
        district,
        sensor_id,
        MAX(cpu) AS peak_cpu,
        AVG(network) AS avg_network
      FROM sensor_readings
      WHERE metric = 'telemetry'
      GROUP BY bucket, district, sensor_id
      WITH DATA;
    `);
    await pool.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS shared_peaks_1m
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('1 minute', ts, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket,
        district,
        sensor_id,
        MAX(cpu) AS peak_cpu,
        AVG(network) AS avg_network
      FROM sensor_readings
      WHERE metric = 'telemetry' AND source = 'shared-simulator'
      GROUP BY bucket, district, sensor_id
      WITH DATA;
    `);
    await pool.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS energy_10s
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('10 seconds', ts, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket,
        district,
        SUM(energy_kwh) AS energy_kwh
      FROM sensor_readings
      WHERE metric = 'telemetry'
      GROUP BY bucket, district
      WITH DATA;
    `);
    await pool.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS energy_2s
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('2 seconds', ts, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket,
        district,
        SUM(energy_kwh) AS energy_kwh
      FROM sensor_readings
      WHERE metric = 'telemetry'
      GROUP BY bucket, district
      WITH DATA;
    `);
    await pool.query(`
      CREATE MATERIALIZED VIEW IF NOT EXISTS shared_energy_2s
      WITH (timescaledb.continuous) AS
      SELECT
        time_bucket('2 seconds', ts, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket,
        district,
        SUM(energy_kwh) AS energy_kwh
      FROM sensor_readings
      WHERE metric = 'telemetry' AND source = 'shared-simulator'
      GROUP BY bucket, district
      WITH DATA;
    `);

    for (const view of [
      "shared_telemetry_1s",
      "shared_peaks_1m",
      "shared_energy_2s",
    ]) {
      await pool.query(
        `
          SELECT remove_continuous_aggregate_policy($1, if_exists => TRUE);
        `,
        [view],
      );
      await pool.query(
        `
          SELECT add_continuous_aggregate_policy(
            $1,
            start_offset => make_interval(hours => $2),
            end_offset => INTERVAL '2 minutes',
            schedule_interval => INTERVAL '1 minute',
            if_not_exists => FALSE
          );
        `,
        [view, aggregateRefreshHours],
      );
    }
  }

  await pool.query(`
    ALTER TABLE sensor_readings
    ADD COLUMN IF NOT EXISTS energy_kwh DOUBLE PRECISION;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sensor_readings_ts ON sensor_readings (ts DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sensor_readings_telemetry_ts
    ON sensor_readings (ts DESC)
    WHERE metric = 'telemetry';
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sensor_readings_sensor_ts ON sensor_readings (sensor_id, ts DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sensor_readings_district_ts ON sensor_readings (district, ts DESC);
  `);
}

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
) {
  const result = await pool.query(text, params);
  return result as pg.QueryResult<T>;
}

export async function writeToDatabases(text: string, params: unknown[] = []) {
  if (!peerPool) {
    await pool.query(text, params);
    return;
  }

  await Promise.all([pool.query(text, params), peerPool.query(text, params)]);
}

export async function queryPeer<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
) {
  if (!peerPool) return null;
  const result = await peerPool.query(text, params);
  return result as pg.QueryResult<T>;
}
