import { query, dbMode } from "./db.js";

const DISTRICTS = ["Centro", "Norte", "Sur", "Este", "Oeste", "Puerto"] as const;
const SENSOR_TYPES = ["temperature", "humidity", "cpu", "memory", "network"] as const;

const sensorSeeds = Array.from({ length: 500 }, (_, index) => ({
  sensor_id: `S-${String(index + 1).padStart(4, "0")}`,
  district: DISTRICTS[index % DISTRICTS.length],
  baseTemp: 18 + (index % 10) * 1.8,
  baseHumidity: 40 + (index % 9) * 5,
  baseCpu: 30 + (index % 12) * 6,
  baseMemory: 42 + (index % 8) * 6,
  baseNetwork: 50 + (index % 11) * 7,
}));

function seededRandom(seed: number) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

async function insertBatch(batchTime: Date, onBatchInserted: () => void) {
  const rnd = seededRandom(batchTime.getTime() % 1000000);
  const values: string[] = [];

  for (const sensor of sensorSeeds) {
    const temperature = Number(
      (
        sensor.baseTemp +
        Math.sin(batchTime.getTime() / 36000 + sensor.baseTemp) * 6 +
        (rnd() - 0.5) * 10
      ).toFixed(2),
    );
    const humidity = Number(
      (
        sensor.baseHumidity +
        Math.cos(batchTime.getTime() / 28000 + sensor.baseTemp) * 8 +
        (rnd() - 0.5) * 14
      ).toFixed(2),
    );
    const cpu = Number(
      (
        sensor.baseCpu +
        Math.sin(batchTime.getTime() / 22000 + sensor.baseTemp) * 22 +
        (rnd() - 0.5) * 28
      ).toFixed(2),
    );
    const memory = Number(
      (
        sensor.baseMemory +
        Math.cos(batchTime.getTime() / 18000 + sensor.baseTemp) * 11 +
        (rnd() - 0.5) * 16
      ).toFixed(2),
    );
    const network = Number(
      (
        sensor.baseNetwork +
        Math.sin(batchTime.getTime() / 15000 + sensor.baseTemp) * 18 +
        (rnd() - 0.5) * 30
      ).toFixed(2),
    );

    const metrics = {
      temperature,
      humidity,
      cpu,
      memory,
      network,
    };

    for (const metric of SENSOR_TYPES) {
      const value = metrics[metric];
      const payload = {
        unit:
          metric === "temperature"
            ? "C"
            : metric === "humidity"
              ? "%"
              : metric === "cpu"
                ? "%"
                : metric === "memory"
                  ? "%"
                  : "Mbps",
        source: "simulator",
        batch: "heavy-load-demo",
        district: sensor.district,
      };

      values.push(`(
        '${batchTime.toISOString()}',
        '${sensor.sensor_id}',
        '${sensor.district}',
        '${metric}',
        ${metric === "temperature" ? value : null},
        ${metric === "humidity" ? value : null},
        ${metric === "cpu" ? value : null},
        ${metric === "memory" ? value : null},
        ${metric === "network" ? value : null},
        ${value},
        'simulator',
        '${JSON.stringify(payload).replace(/'/g, "''")}'::jsonb
      )`);
    }
  }

  if (values.length === 0) {
    return;
  }

  await query(`
    INSERT INTO sensor_readings (
      ts, sensor_id, district, metric,
      temperature, humidity, cpu, memory, network,
      value, source, metadata
    ) VALUES ${values.join(", ")}
  `);
  onBatchInserted();
}

export function startSimulator(onBatchInserted: () => void = () => {}) {
  const intervalMs = Number(process.env.SIMULATOR_INTERVAL_MS ?? 2000);
  if (!Number.isInteger(intervalMs) || intervalMs < 1000) {
    throw new Error("SIMULATOR_INTERVAL_MS must be an integer greater than or equal to 1000");
  }

  let stopped = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const scheduleNextBatch = () => {
    const now = Date.now();
    const nextBatchTime = Math.floor(now / intervalMs) * intervalMs + intervalMs;
    timeout = setTimeout(() => void runBatch(nextBatchTime), nextBatchTime - now);
  };

  const runBatch = async (batchTimestamp: number) => {
    try {
      await insertBatch(new Date(batchTimestamp), onBatchInserted);
    } catch (error) {
      console.error("[simulator] error inserting batch:", error);
    } finally {
      if (!stopped) {
        scheduleNextBatch();
      }
    }
  };
  scheduleNextBatch();

  const rowsPerSecond = (sensorSeeds.length * SENSOR_TYPES.length * 1000) / intervalMs;
  console.log(
    `[simulator] active in ${dbMode} mode (${rowsPerSecond} rows/s approx; interval ${intervalMs} ms, synchronized timestamps)`,
  );

  return () => {
    stopped = true;
    if (timeout) clearTimeout(timeout);
  };
}
