import { useEffect, useRef, useState } from "react";

// Frontend-only simulator. Stands in for backend scheduled jobs that insert
// mocked sensor readings into TimescaleDB hypertables.

export const DISTRICTS = ["Centro", "Norte", "Sur", "Este", "Oeste", "Puerto"] as const;
export type District = (typeof DISTRICTS)[number];
export type Range = "1m" | "5m" | "1h" | "24h" | "7d";

export const RANGES: Record<Range, { points: number; bucket: string; interval: string; label: string }> = {
  "1m": { points: 60, bucket: "1 second", interval: "1 minute", label: "1 s" },
  "5m": { points: 150, bucket: "2 seconds", interval: "5 minutes", label: "2 s" },
  "1h": { points: 60, bucket: "1 minute", interval: "1 hour", label: "1 min" },
  "24h": { points: 96, bucket: "15 minutes", interval: "24 hours", label: "15 min" },
  "7d": { points: 84, bucket: "2 hours", interval: "7 days", label: "2 h" },
};

const BASE_TEMP: Record<District, number> = { Centro: 24, Norte: 20, Sur: 26, Este: 22, Oeste: 21, Puerto: 19 };
const SENSORS = 12480;
const HISTORY = 150;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Reading {
  temp: Record<District, number>;
  humidity: number;
  aqi: number;
  energy: number;
  noise: number;
}

export interface FeedItem {
  id: number;
  sensor: string;
  district: District;
  metric: string;
  value: string;
}

export interface QueryBench {
  title: string;
  sql: string;
  rows: string;
  tsdb: number;
  pg: number;
}

const QUERIES: Omit<QueryBench, "tsdb" | "pg">[] = [
  {
    title: "Temperatura media por barrio",
    sql: "SELECT time_bucket('{bucket}', ts) AS t, district, avg(temp)\nFROM readings\nWHERE ts > now() - INTERVAL '{interval}'\nGROUP BY t, district ORDER BY t;",
    rows: "38,2 M",
  },
  {
    title: "Picos de contaminación (AQI > 100)",
    sql: "SELECT sensor_id, max(aqi), last(aqi, ts)\nFROM air_quality\nWHERE ts > now() - INTERVAL '{interval}' AND aqi > 100\nGROUP BY sensor_id;",
    rows: "12,7 M",
  },
  {
    title: "Consumo eléctrico (agregado continuo)",
    sql: "SELECT bucket, district, sum_kwh\nFROM energy_hourly  -- continuous aggregate\nWHERE bucket > now() - INTERVAL '{interval}'\nORDER BY bucket;",
    rows: "210 M",
  },
];

function nextReading(prev: Reading, rnd: () => number, t: number): Reading {
  const temp = {} as Record<District, number>;
  for (const d of DISTRICTS) {
    const target = BASE_TEMP[d] + Math.sin(t / 40) * 1.5;
    temp[d] = +(prev.temp[d] + (target - prev.temp[d]) * 0.08 + (rnd() - 0.5) * 0.6).toFixed(2);
  }
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  return {
    temp,
    humidity: +clamp(prev.humidity + (rnd() - 0.5) * 1.6, 35, 85).toFixed(1),
    aqi: Math.round(clamp(prev.aqi + (rnd() - 0.48) * 6, 15, 160)),
    energy: +clamp(prev.energy + (rnd() - 0.5) * 8, 180, 420).toFixed(1),
    noise: +clamp(prev.noise + (rnd() - 0.5) * 2, 40, 85).toFixed(1),
  };
}

function initialState() {
  const rnd = mulberry32(42);
  let r: Reading = {
    temp: { ...BASE_TEMP },
    humidity: 58,
    aqi: 48,
    energy: 290,
    noise: 58,
  };
  const history: Reading[] = [];
  for (let i = 0; i < HISTORY; i++) {
    r = nextReading(r, rnd, i);
    history.push(r);
  }
  // Long-range synthetic series (already bucketed, like a continuous aggregate).
  const longRange = {} as Record<"1h" | "24h" | "7d", Reading[]>;
  (["1h", "24h", "7d"] as const).forEach((k, idx) => {
    const lr = mulberry32(100 + idx);
    let x = history[0]!;
    const arr: Reading[] = [];
    for (let i = 0; i < RANGES[k].points; i++) {
      x = nextReading(x, lr, i * (idx + 1) * 3);
      arr.push(x);
    }
    longRange[k] = arr;
  });
  // Heatmap: 24 hours x districts
  const hr = mulberry32(7);
  const heat = DISTRICTS.map((d) =>
    Array.from({ length: 24 }, (_, h) => +(BASE_TEMP[d] - 4 + Math.sin(((h - 9) / 24) * Math.PI * 2) * 5 + hr() * 1.5).toFixed(1)),
  );
  return {
    history,
    longRange,
    heat,
    ingest: 49870,
    totalRows: 4_213_884_120,
    chunks: 18_432,
    compression: 14.2,
    p95: 9.4,
    feed: [] as FeedItem[],
    queryIdx: 0,
    bench: QUERIES.map((q) => ({ ...q, tsdb: 9.4, pg: 780 })),
    tickCount: 0,
  };
}

export type SimState = ReturnType<typeof initialState>;

export function useSimulation(running: boolean) {
  const [state, setState] = useState<SimState>(initialState);
  const rndRef = useRef<() => number>(Math.random);
  const feedId = useRef(0);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const rnd = rndRef.current;
      setState((s) => {
        const last = s.history[s.history.length - 1]!;
        const next = nextReading(last, rnd, s.tickCount + HISTORY);
        const history = [...s.history.slice(1), next];
        const longRange = { ...s.longRange };
        (["1h", "24h", "7d"] as const).forEach((k) => {
          const arr = [...longRange[k]];
          const tail = arr[arr.length - 1]!;
          arr[arr.length - 1] = nextReading(tail, rnd, s.tickCount);
          longRange[k] = arr;
        });
        const ingest = Math.round(Math.max(38000, Math.min(62000, s.ingest + (rnd() - 0.5) * 3000)));
        const newFeed: FeedItem[] = Array.from({ length: 2 }, () => {
          const d = DISTRICTS[Math.floor(rnd() * DISTRICTS.length)]!;
          const m = Math.floor(rnd() * 4);
          const metric = ["temp", "humedad", "aqi", "energía"][m]!;
          const value =
            m === 0 ? `${next.temp[d].toFixed(1)} °C` : m === 1 ? `${next.humidity}%` : m === 2 ? `${next.aqi}` : `${(next.energy / 6).toFixed(1)} kW`;
          return {
            id: ++feedId.current,
            sensor: `${d.slice(0, 3).toUpperCase()}-${String(Math.floor(rnd() * 2080)).padStart(4, "0")}`,
            district: d,
            metric,
            value,
          };
        });
        const bench = s.bench.map((b, i) => ({
          ...b,
          tsdb: +Math.max(3, (6 + i * 4) + (rnd() - 0.5) * 3).toFixed(1),
          pg: Math.round((520 + i * 380) + (rnd() - 0.5) * 120),
        }));
        return {
          ...s,
          history,
          longRange,
          ingest,
          totalRows: s.totalRows + ingest,
          chunks: s.chunks + (s.tickCount % 30 === 0 ? 1 : 0),
          compression: +Math.max(12, Math.min(16, s.compression + (rnd() - 0.5) * 0.1)).toFixed(1),
          p95: +Math.max(5, Math.min(18, s.p95 + (rnd() - 0.5) * 1.4)).toFixed(1),
          feed: [...newFeed, ...s.feed].slice(0, 14),
          queryIdx: s.tickCount % 6 === 5 ? (s.queryIdx + 1) % QUERIES.length : s.queryIdx,
          bench,
          tickCount: s.tickCount + 1,
        };
      });
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  return state;
}

export function seriesFor(state: SimState, range: Range): Reading[] {
  if (range === "1m") return state.history.slice(-60);
  if (range === "5m") return state.history;
  return state.longRange[range];
}

export { SENSORS };

export const fmt = (n: number, d = 0) => n.toLocaleString("es-ES", { minimumFractionDigits: d, maximumFractionDigits: d });
