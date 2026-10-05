import { dbMode, query, queryPeer, writeToDatabases } from "./db.js";

const DISTRICTS = ["Centro", "Norte", "Sur", "Este", "Oeste", "Puerto"] as const;
const RETENTION_HOURS = Math.max(1, Number(process.env.DATA_RETENTION_HOURS ?? 1));
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const SAMPLE_INTERVAL_SECONDS = 0.25;

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

async function insertBatch() {
  const now = new Date();
  const rnd = seededRandom(now.getTime() % 1000000);
  const values: string[] = [];

  for (const sensor of sensorSeeds) {
    const temperature = Number(
      (
        sensor.baseTemp +
        Math.sin(now.getTime() / 36000 + sensor.baseTemp) * 6 +
        (rnd() - 0.5) * 10
      ).toFixed(2),
    );
    const humidity = Number(
      (
        sensor.baseHumidity +
        Math.cos(now.getTime() / 28000 + sensor.baseTemp) * 8 +
        (rnd() - 0.5) * 14
      ).toFixed(2),
    );
    const cpu = Math.min(
      100,
      Math.max(
        0,
        Number(
          (
            sensor.baseCpu +
            Math.sin(now.getTime() / 22000 + sensor.baseTemp) * 22 +
            (rnd() - 0.5) * 28
          ).toFixed(2),
        ),
      ),
    );
    const memory = Math.min(
      100,
      Math.max(
        0,
        Number(
          (
            sensor.baseMemory +
            Math.cos(now.getTime() / 18000 + sensor.baseTemp) * 11 +
            (rnd() - 0.5) * 16
          ).toFixed(2),
        ),
      ),
    );
    const network = Number(
      (
        sensor.baseNetwork +
        Math.sin(now.getTime() / 15000 + sensor.baseTemp) * 18 +
        (rnd() - 0.5) * 30
      ).toFixed(2),
    );

    const energyKwh = ((25 + cpu * 0.75) * SAMPLE_INTERVAL_SECONDS) / 3_600_000;
    const payload = {
      source: "shared-simulator",
      batch: "shared-timeseries-demo",
      district: sensor.district,
    };

    values.push(`(
      '${now.toISOString()}',
      '${sensor.sensor_id}',
      '${sensor.district}',
      'telemetry',
      ${temperature},
      ${humidity},
      ${cpu},
      ${memory},
      ${network},
      ${temperature},
      ${energyKwh},
      'shared-simulator',
      '${JSON.stringify(payload).replace(/'/g, "''")}'::jsonb
    )`);
  }

  if (values.length === 0) {
    return;
  }

  await writeToDatabases(`
    INSERT INTO sensor_readings (
      ts, sensor_id, district, metric,
      temperature, humidity, cpu, memory, network,
      value, energy_kwh, source, metadata
    ) VALUES ${values.join(", ")}
  `);
}

export function startSimulator() {
  if (dbMode !== "plain") {
    console.log("[simulator] using shared telemetry from PostgreSQL API");
    return () => {};
  }

  void insertBatch().catch((error) => {
    console.error("[simulator] initial shared batch insert failed:", error);
  });

  const cleanOldReadings = async () => {
    try {
      const result = await query(
        "DELETE FROM sensor_readings WHERE source IN ('simulator', 'shared-simulator') AND ts < NOW() - make_interval(hours => $1)",
        [RETENTION_HOURS],
      );
      const peerResult = await queryPeer(
        "SELECT drop_chunks('sensor_readings', older_than => make_interval(hours => $1)) AS chunk",
        [RETENTION_HOURS],
      );
      if (result.rowCount) {
        console.log(
          `[retention] removed ${result.rowCount} simulator rows older than ${RETENTION_HOURS} hours`,
        );
      }
      if (peerResult?.rowCount) {
        console.log(
          `[retention] dropped ${peerResult.rowCount} shared TimescaleDB chunks older than ${RETENTION_HOURS} hours`,
        );
      }
    } catch (error) {
      console.error("[retention] error removing old simulator rows:", error);
    }
  };

  void cleanOldReadings();
  const cleanupInterval = setInterval(() => void cleanOldReadings(), CLEANUP_INTERVAL_MS);

  const interval =
    setInterval(() => {
      void insertBatch().catch((error) => {
        console.error("[simulator] error inserting shared batch:", error);
      });
    }, 250);

  console.log(
    `[simulator] shared telemetry generator active (${sensorSeeds.length / SAMPLE_INTERVAL_SECONDS} rows/s approx)`,
  );

  return () => {
    clearInterval(interval);
    clearInterval(cleanupInterval);
  };
}
