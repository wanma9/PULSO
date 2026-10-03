import express from "express";
import type { Response } from "express";
import cors from "cors";
import dotenv from "dotenv";

import { dbMode, ensureSchema, pool, query } from "./db.js";
import { startSimulator } from "./simulator.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? (dbMode === "timescale" ? 4002 : 4001));
const allowedOrigins = new Set(
  (process.env.CORS_ORIGIN ?? "http://localhost:5173,http://localhost:8081")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error(`Origin ${origin} is not allowed by CORS`));
    },
    credentials: true,
  }),
);
app.use(express.json());

const eventClients = new Set<Response>();

app.get("/api/events", (_req, res) => {
  res.status(200);
  res.set({
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write("retry: 1000\n\n");
  eventClients.add(res);

  const heartbeat = setInterval(() => {
    res.write(": keep-alive\n\n");
  }, 25000);
  res.on("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(res);
  });
});

function notifyReadingsInserted() {
  const event = `event: readings-inserted\ndata: ${JSON.stringify({ mode: dbMode, at: new Date().toISOString() })}\n\n`;
  for (const client of eventClients) {
    client.write(event);
  }
}

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
      "/api/dashboard",
      "/api/events",
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

app.get("/api/dashboard", async (req, res) => {
  const ranges = {
    "1m": { interval: "1 minute", bucket: "1 second" },
    "5m": { interval: "5 minutes", bucket: "2 seconds" },
    "1h": { interval: "1 hour", bucket: "1 minute" },
    "24h": { interval: "24 hours", bucket: "15 minutes" },
    "7d": { interval: "7 days", bucket: "2 hours" },
  } as const;
  const range = typeof req.query.range === "string" && req.query.range in ranges
    ? req.query.range as keyof typeof ranges
    : "5m";
  const { interval, bucket } = ranges[range];
  const bucketExpression = dbMode === "timescale"
    ? `time_bucket(INTERVAL '${bucket}', ts)`
    : `date_bin(INTERVAL '${bucket}', ts, TIMESTAMPTZ '2000-01-01')`;
  const [statsResult, overviewResult, seriesResult, heatmapResult, feedResult] = await Promise.all([
    query(`
      SELECT
        (SELECT MAX(ts) FROM sensor_readings) AS last_reading_at
    `),
    query(`
      SELECT
        district,
        AVG(temperature) AS avg_temperature,
        AVG(humidity) AS avg_humidity,
        AVG(cpu) AS avg_cpu,
        AVG(memory) AS avg_memory,
        AVG(network) AS avg_network,
        MAX(cpu) AS peak_cpu,
        COUNT(*) AS samples,
        COUNT(humidity) AS humidity_samples,
        COUNT(cpu) AS cpu_samples,
        COUNT(memory) AS memory_samples,
        COUNT(network) AS network_samples
      FROM sensor_readings
      WHERE ts > NOW() - INTERVAL '5 minutes'
      GROUP BY district
      ORDER BY district
    `),
    query(`
      SELECT
        ${bucketExpression} AS bucket,
        district,
        AVG(temperature) AS temperature,
        COUNT(temperature) AS temperature_samples,
        AVG(humidity) AS humidity,
        COUNT(humidity) AS humidity_samples,
        AVG(cpu) AS cpu,
        COUNT(cpu) AS cpu_samples,
        AVG(memory) AS memory,
        COUNT(memory) AS memory_samples,
        AVG(network) AS network,
        COUNT(network) AS network_samples
      FROM sensor_readings
      WHERE ts > NOW() - INTERVAL '${interval}'
      GROUP BY bucket, district
      ORDER BY bucket, district
    `),
    query(`
      SELECT
        district,
        date_trunc('minute', ts) AS bucket,
        AVG(temperature) AS temperature,
        COUNT(temperature) AS samples
      FROM sensor_readings
      WHERE ts > NOW() - INTERVAL '5 minutes'
      GROUP BY district, bucket
      ORDER BY district, bucket
    `),
    query(`
      SELECT ts, sensor_id, district, metric, value
      FROM sensor_readings
      ORDER BY ts DESC
      LIMIT 14
    `),
  ]);

  const stats = statsResult.rows[0]!;
  res.json({
    mode: dbMode,
    database: dbMode === "timescale" ? "pulse_timescale" : "pulse_plain",
    range,
    stats: {
      lastReadingAt: stats.last_reading_at,
    },
    overview: overviewResult.rows.map((row) => ({
      ...row,
      avg_temperature: row.avg_temperature === null ? null : Number(row.avg_temperature),
      avg_humidity: row.avg_humidity === null ? null : Number(row.avg_humidity),
      avg_cpu: row.avg_cpu === null ? null : Number(row.avg_cpu),
      avg_memory: row.avg_memory === null ? null : Number(row.avg_memory),
      avg_network: row.avg_network === null ? null : Number(row.avg_network),
      peak_cpu: row.peak_cpu === null ? null : Number(row.peak_cpu),
      samples: Number(row.samples),
      humidity_samples: Number(row.humidity_samples),
      cpu_samples: Number(row.cpu_samples),
      memory_samples: Number(row.memory_samples),
      network_samples: Number(row.network_samples),
    })),
    series: seriesResult.rows.map((row) => ({
      ...row,
      bucket: row.bucket,
      temperature: row.temperature === null ? null : Number(row.temperature),
      temperature_samples: Number(row.temperature_samples),
      humidity: row.humidity === null ? null : Number(row.humidity),
      humidity_samples: Number(row.humidity_samples),
      cpu: row.cpu === null ? null : Number(row.cpu),
      cpu_samples: Number(row.cpu_samples),
      memory: row.memory === null ? null : Number(row.memory),
      memory_samples: Number(row.memory_samples),
      network: row.network === null ? null : Number(row.network),
      network_samples: Number(row.network_samples),
    })),
    heatmap: heatmapResult.rows.map((row) => ({
      ...row,
      bucket: new Date(row.bucket).getTime(),
      temperature: row.temperature === null ? null : Number(row.temperature),
      samples: Number(row.samples),
    })),
    feed: feedResult.rows,
  });
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
        WHERE ts > NOW() - INTERVAL '5 minutes'
        GROUP BY district
        ORDER BY avg_temperature DESC;
      `,
    },
    {
      name: "hot_spots",
      title: "Picos de CPU por barrio",
      sql: `
        SELECT district, MAX(cpu) AS peak_cpu, AVG(network) AS avg_network
        FROM sensor_readings
        WHERE ts > NOW() - INTERVAL '5 minutes'
        GROUP BY district
        ORDER BY peak_cpu DESC;
      `,
    },
    {
      name: "time_bucket_rollup",
      title: "CPU media por minuto",
      sql: `
        SELECT date_trunc('minute', ts) AS bucket, AVG(cpu) AS avg_cpu
        FROM sensor_readings
        WHERE ts > NOW() - INTERVAL '5 minutes'
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
        SELECT time_bucket('1 minute', ts) AS bucket, district, AVG(temperature) AS avg_temperature
        FROM sensor_readings
        WHERE ts > NOW() - INTERVAL '5 minutes'
        GROUP BY bucket, district
        ORDER BY bucket, district;
      `,
    },
    {
      name: "hot_spots",
      title: "Picos de CPU por barrio",
      sql: `
        SELECT time_bucket('1 minute', ts) AS bucket, district, MAX(cpu) AS peak_cpu, AVG(network) AS avg_network
        FROM sensor_readings
        WHERE ts > NOW() - INTERVAL '5 minutes'
        GROUP BY bucket, district
        ORDER BY bucket DESC, peak_cpu DESC;
      `,
    },
    {
      name: "time_bucket_rollup",
      title: "CPU media por minuto",
      sql: `
        SELECT time_bucket('1 minute', ts) AS bucket, AVG(cpu) AS avg_cpu
        FROM sensor_readings
        WHERE ts > NOW() - INTERVAL '5 minutes'
        GROUP BY bucket
        ORDER BY bucket ASC
        LIMIT 60;
      `,
    },
  ];

  const benchmarks = dbMode === "timescale" ? timescaleQueries : plainQueries;

  type ExplainAnalyzeDocument = {
    "QUERY PLAN": Array<{
      "Execution Time": number;
      Plan: {
        "Actual Rows"?: number;
        "Actual Loops"?: number;
      };
    }>;
  };
  const results = [] as Array<{ name: string; title: string; ms: number; rows: number; sql: string; engine: string }>;

  for (const benchmark of benchmarks) {
    const explainResult = await query<ExplainAnalyzeDocument>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${benchmark.sql}`,
    );
    const analysis = explainResult.rows[0]?.["QUERY PLAN"]?.[0];
    if (!analysis) {
      throw new Error(`La base de datos no devolvió el plan de ejecución para ${benchmark.name}`);
    }
    results.push({
      name: benchmark.name,
      title: benchmark.title,
      ms: Number(analysis["Execution Time"].toFixed(2)),
      rows: Math.round((analysis.Plan["Actual Rows"] ?? 0) * (analysis.Plan["Actual Loops"] ?? 1)),
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
  startSimulator(notifyReadingsInserted);

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
