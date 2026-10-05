import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { dbMode, ensureSchema, pool, query } from "./db.js";
import { startSimulator } from "./simulator.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT ?? (dbMode === "timescale" ? 4002 : 4001));
const corsOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173,http://localhost:8080")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({ origin: corsOrigins, credentials: true }));
app.use(express.json());

app.get("/health", async (_req, res) => {
  const { rows } = await query(
    "SELECT NOW() as now, current_database() as db, current_user as user",
  );
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
    endpoints: ["/api/overview", "/api/series", "/api/alerts", "/api/queries/performance"],
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
    WHERE source = 'shared-simulator'
    AND ts >= date_trunc('minute', NOW()) - INTERVAL '15 minutes'
    AND ts < date_trunc('minute', NOW())
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
    WHERE source = 'shared-simulator'
      AND ts >= NOW() - INTERVAL '${interval}'
    GROUP BY bucket
    ORDER BY bucket ASC
    LIMIT 180
  `);

  res.json({
    mode: dbMode,
    metric: selectedMetric,
    window,
    data: rows.map((row) => ({
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
    WHERE source = 'shared-simulator'
    AND ts >= date_trunc('minute', NOW()) - INTERVAL '15 minutes'
    AND ts < date_trunc('minute', NOW())
    GROUP BY district
    HAVING MAX(cpu) > 80 OR AVG(network) > 120 OR MAX(temperature) > 35
    ORDER BY peak_cpu DESC
  `);

  res.json({ mode: dbMode, alerts: rows });
});

app.get("/api/queries/performance", async (req, res) => {
  const targetRows = 50_000;
  const timedRuns = 2;
  const requestedAt = req.query.at;
  const anchor =
    requestedAt === undefined
      ? new Date()
      : typeof requestedAt === "string"
        ? new Date(requestedAt)
        : new Date(Number.NaN);
  if (Number.isNaN(anchor.getTime())) {
    res.status(400).json({ error: "El parámetro at debe ser una fecha ISO válida." });
    return;
  }
  const minuteBoundary = Math.floor(anchor.getTime() / 60_000) * 60_000;
  const windowEnd = new Date(minuteBoundary - 3 * 60_000);
  const windowStart = new Date(windowEnd.getTime() - 3 * 60_000);
  const benchmarks = [
    {
      name: "temperature_samples",
      title: "Temperatura media por sensor y segundo",
      value: "AVG(temperature) AS avg_temperature",
      timescaleValue: "avg_temperature",
    },
    {
      name: "cpu_network_samples",
      title: "Pico CPU y media de red por sensor y segundo",
      value: "MAX(cpu) AS peak_cpu, AVG(network) AS avg_network",
      timescaleValue: "peak_cpu, avg_network",
    },
    {
      name: "energy_samples",
      title: "Consumo eléctrico por sensor y segundo",
      value: "SUM(energy_kwh) AS energy_kwh",
      timescaleValue: "energy_kwh",
    },
  ].map((benchmark) => ({
    name: benchmark.name,
    title: benchmark.title,
    sql: `
      ${
        dbMode === "timescale"
          ? `
            SELECT bucket, district, sensor_id, ${benchmark.timescaleValue}
            FROM shared_sensor_telemetry_1s
            WHERE bucket >= $1 AND bucket < $2
            ORDER BY bucket, district, sensor_id
            LIMIT ${targetRows};
          `
          : `
            SELECT date_bin('1 second', ts, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket,
              district, sensor_id, ${benchmark.value}
            FROM sensor_readings
            WHERE metric = 'telemetry' AND source = 'shared-simulator'
              AND ts >= $1 AND ts < $2
            GROUP BY bucket, district, sensor_id
            ORDER BY bucket, district, sensor_id
            LIMIT ${targetRows};
          `
      }
    `,
  }));

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
    const run = async () => {
      const explainResult = await query<ExplainAnalyzeDocument>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${benchmark.sql}`,
        [windowStart, windowEnd],
      );
      const analysis = explainResult.rows[0]?.["QUERY PLAN"]?.[0];
      if (!analysis) {
        throw new Error(`La base de datos no devolvió el plan de ejecución para ${benchmark.name}`);
      }
      return {
        ms: analysis["Execution Time"],
        rows: Math.round(
          (analysis.Plan["Actual Rows"] ?? 0) * (analysis.Plan["Actual Loops"] ?? 1),
        ),
      };
    };

    const warmupRun = await run();
    const measuredRuns = [];
    for (let runIndex = 0; runIndex < timedRuns; runIndex++) {
      measuredRuns.push(await run());
    }
    const invalidRun = [warmupRun, ...measuredRuns].find(
      (result) => result.rows !== targetRows,
    );
    if (invalidRun) {
      res.status(503).json({
        error: `La consulta ${benchmark.name} produjo ${invalidRun.rows} filas reales; se requieren exactamente ${targetRows}.`,
        expectedRows: targetRows,
        availableRows: invalidRun.rows,
      });
      return;
    }
    const averageMs =
      measuredRuns.reduce((sum, result) => sum + result.ms, 0) / measuredRuns.length;
    results.push({
      name: benchmark.name,
      title: benchmark.title,
      ms: Number(averageMs.toFixed(2)),
      rows: measuredRuns[0].rows,
      sql: benchmark.sql.replace(/\s+/g, " ").trim(),
      engine: dbMode === "timescale" ? "TimescaleDB" : "PostgreSQL",
    });
  }

  const avgMs = results.reduce((sum, item) => sum + item.ms, 0) / results.length;

  res.json({
    mode: dbMode,
    averageMs: Number(avgMs.toFixed(2)),
    window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
    queries: results,
    benchmark: {
      label: dbMode === "timescale" ? "TimescaleDB continuous aggregate" : "Baseline PostgreSQL",
      summary: dbMode === "timescale"
        ? "1-second per-sensor continuous aggregate; refreshed every minute with a 2-minute end offset."
        : "Raw aggregation over the same telemetry using PostgreSQL's time index, one warm-up and two timed runs.",
      maintenanceIncluded: false,
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
