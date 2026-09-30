import pg, { type PoolConfig } from "pg";
import dotenv from "dotenv";

dotenv.config();

export type DbMode = "plain" | "timescale";

export const dbMode: DbMode = (process.env.DB_MODE === "timescale" ? "timescale" : "plain");

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
      source TEXT NOT NULL DEFAULT 'simulator',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    );
  `);

  if (dbMode === "timescale") {
    await pool.query(`
      SELECT create_hypertable('sensor_readings', 'ts', if_not_exists => TRUE);
    `);
  }

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sensor_readings_ts ON sensor_readings (ts DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sensor_readings_sensor_ts ON sensor_readings (sensor_id, ts DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_sensor_readings_district_ts ON sensor_readings (district, ts DESC);
  `);
}

export async function query<T extends Record<string, any> = Record<string, any>>(text: string, params: unknown[] = []) {
  const result = await pool.query(text, params);
  return result as pg.QueryResult<T>;
}
