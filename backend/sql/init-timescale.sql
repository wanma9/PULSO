CREATE EXTENSION IF NOT EXISTS timescaledb;

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
  metadata JSONB NOT NULL DEFAULT '{}'
);

SELECT create_hypertable(
  'sensor_readings',
  'ts',
  chunk_time_interval => INTERVAL '10 minutes',
  if_not_exists => TRUE
);

ALTER TABLE sensor_readings SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'sensor_id',
  timescaledb.compress_orderby = 'ts DESC'
);

SELECT add_compression_policy(
  'sensor_readings',
  INTERVAL '5 minutes',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => TRUE
);

SELECT set_chunk_time_interval('sensor_readings', INTERVAL '2 minutes');

CREATE INDEX IF NOT EXISTS idx_sensor_readings_ts ON sensor_readings (ts DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_telemetry_ts
  ON sensor_readings (ts DESC) WHERE metric = 'telemetry';
CREATE INDEX IF NOT EXISTS idx_sensor_readings_sensor_ts ON sensor_readings (sensor_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_district_ts ON sensor_readings (district, ts DESC);
