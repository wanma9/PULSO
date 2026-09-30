import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { dbMode, ensureSchema, pool, query } from "./db.js";
import { startSimulator } from "./simulator.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? (dbMode === "timescale" ? 4002 : 4001));

app.use(cors({ origin: process.env.CORS_ORIGIN ?? "http://localhost:5173", credentials: true }));
app.use(express.json());

app.get("/health", async (_req, res) => {
  const { rows } = await query("SELECT NOW() as now, current_database() as db, current_user as user");
  const row = (rows[0] ?? {}) as Record<string, unknown>;
  res.json({
    status: "ok",
    mode: dbMode,
    db: row.db,
    time: row.now,
    user: row.user,
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    mode: dbMode,
    database: dbMode === "timescale" ? "postgresql+timescaledb" : "postgresql-standard",
    demo: "TimescaleDB performance comparison",
    endpoints: [
      "/api/overview",
      "/api/series",
      "/api/alerts",
      "/api/queries/performance",
    ],
  });
});

app.get("/api/overview", async (_req, res) => {
  const { rows } = await query(`
    SELECT
      district,
      AVG(temperature) AS avg_temperature,
      AVG(humidity) AS avg_humidity,
      AVG(cpu) AS avg_cpu,
      AVG(network) AS avg_network,
      MAX(cpu) AS peak_cpu,
      COUNT(*) AS samples
    FROM sensor_readings
    WHERE ts > NOW() - INTERVAL '15 minutes'
    GROUP BY district
    ORDER BY avg_temperature DESC
  `);

  res.json({ mode: dbMode, data: rows });
});

app.get("/api/series", async (req, res) => {
  const metric = (req.query.metric ?? "temperature") as string;
  const validMetrics = new Set(["temperature", "humidity", "cpu", "memory", "network"]);
  const selectedMetric = validMetrics.has(metric) ? metric : "temperature";
  const window = (req.query.window ?? "10m") as string;
  const intervals: Record<string, string> = {
    "5m": "5 minutes",
    "10m": "10 minutes",
    "30m": "30 minutes",
    "1h": "1 hour",
    "6h": "6 hours",
  };
  const interval = intervals[window] ?? "30 minutes";

  const { rows } = await query(`
    SELECT
      date_trunc('minute', ts) AS bucket,
      AVG(${selectedMetric}) AS value
    FROM sensor_readings
    WHERE ts > NOW() - INTERVAL '${interval}'
    GROUP BY bucket
    ORDER BY bucket ASC
    LIMIT 180
  `);

  res.json({
    mode: dbMode,
    metric: selectedMetric,
    window,
    data: rows.map((row: any) => ({
      bucket: row.bucket,
      value: Number(row.value ?? 0),
    })),
  });
});

app.get("/api/alerts", async (_req, res) => {
  const { rows } = await query(`
    SELECT
      district,
      MAX(cpu) AS peak_cpu,
      AVG(network) AS avg_network,
      MAX(temperature) AS max_temperature
    FROM sensor_readings
    WHERE ts > NOW() - INTERVAL '15 minutes'
    GROUP BY district
    HAVING MAX(cpu) > 80 OR AVG(network) > 120 OR MAX(temperature) > 35
    ORDER BY peak_cpu DESC
  `);

  res.json({ mode: dbMode, alerts: rows });
});

app.get("/api/queries/performance", async (_req, res) => {
  const plainQueries = [
    {
      name: "rolling_window_avg",
      title: "Temperatura media por barrio",
      sql: `
        SELECT district, AVG(temperature) AS avg_temperature
        FROM sensor_readings
        WHERE ts > NOW() - INTERVAL '30 minutes'
        GROUP BY district
        ORDER BY avg_temperature DESC;
      `,
    },
    {
      name: "hot_spots",
      title: "Picos de contaminación",
      sql: `
        SELECT district, MAX(cpu) AS peak_cpu, AVG(network) AS avg_network
        FROM sensor_readings
        WHERE ts > NOW() - INTERVAL '20 minutes'
        GROUP BY district
        ORDER BY peak_cpu DESC;
      `,
    },
    {
      name: "time_bucket_rollup",
      title: "Consumo eléctrico (agregado continuo)",
      sql: `
        SELECT date_trunc('minute', ts) AS bucket, AVG(cpu) AS avg_cpu
        FROM sensor_readings
        WHERE ts > NOW() - INTERVAL '1 hour'
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT 60;
      `,
    },
  ];

  const timescaleQueries = [
    {
      name: "rolling_window_avg",
      title: "Temperatura media por barrio",
      sql: `
        SELECT time_bucket('2 seconds', ts) AS bucket, district, AVG(temperature) AS avg_temperature
        FROM sensor_readings
        WHERE ts > NOW() - INTERVAL '30 minutes'
        GROUP BY bucket, district
        ORDER BY bucket, district;
      `,
    },
    {
      name: "hot_spots",
      title: "Picos de contaminación",
      sql: `
        SELECT district, MAX(cpu) AS peak_cpu, AVG(network) AS avg_network
        FROM sensor_readings
        WHERE ts > NOW() - INTERVAL '20 minutes'
        GROUP BY district
        ORDER BY peak_cpu DESC;
      `,
    },
    {
      name: "time_bucket_rollup",
      title: "Consumo eléctrico (agregado continuo)",
      sql: `
        SELECT time_bucket('1 minute', ts) AS bucket, AVG(cpu) AS avg_cpu
        FROM sensor_readings
        WHERE ts > NOW() - INTERVAL '1 hour'
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT 60;
      `,
    },
  ];

  const benchmarks = dbMode === "timescale" ? timescaleQueries : plainQueries;

  const results = [] as Array<{ name: string; title: string; ms: number; rows: number; sql: string; engine: string }>;

  for (const benchmark of benchmarks) {
    const started = process.hrtime.bigint();
    const result = await query(benchmark.sql);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    results.push({
      name: benchmark.name,
      title: benchmark.title,
      ms: Number(elapsedMs.toFixed(2)),
      rows: Number(result.rowCount ?? 0),
      sql: benchmark.sql.replace(/\s+/g, " ").trim(),
      engine: dbMode === "timescale" ? "TimescaleDB" : "PostgreSQL",
    });
  }

  const avgMs = results.reduce((sum, item) => sum + item.ms, 0) / results.length;

  res.json({
    mode: dbMode,
    averageMs: Number(avgMs.toFixed(2)),
    queries: results,
    benchmark: {
      label: dbMode === "timescale" ? "TimescaleDB optimized" : "Baseline PostgreSQL",
      summary: dbMode === "timescale" ? "Hypertable + time_bucket for efficient time-window queries." : "Standard relational aggregation without time-series optimization.",
    },
  });
});

async function startServer() {
  await ensureSchema();
  startSimulator();

  app.listen(port, () => {
    console.log(`[api] ${dbMode} backend running on http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error("[api] startup failed:", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await pool.end();
  process.exit(0);
});
