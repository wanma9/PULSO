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
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_sensor_readings_ts ON sensor_readings (ts DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_sensor_ts ON sensor_readings (sensor_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_sensor_readings_district_ts ON sensor_readings (district, ts DESC);
