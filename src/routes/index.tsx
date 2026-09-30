import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Bars, LineChart, Sparkline } from "@/components/charts";
import { DISTRICTS, RANGES, SENSORS, fmt, seriesFor, useSimulation, type Range, type SimState } from "@/lib/simulation";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PULSO — Sensores urbanos en tiempo real con TimescaleDB" },
      { name: "description", content: "Demo de rendimiento de TimescaleDB: miles de sensores de ciudad enviando temperatura, humedad, aire y energía cada segundo." },
      { property: "og:title", content: "PULSO — Sensores urbanos en tiempo real" },
      { property: "og:description", content: "Series temporales masivas y análisis en tiempo real sobre TimescaleDB." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)", "var(--chart-6)"];
const NAV = ["Resumen", "Sensores", "Consultas", "Alertas", "Mapa"];
const BACKENDS = {
  timescale: "http://localhost:4002",
  plain: "http://localhost:4001",
} as const;

type BackendMode = keyof typeof BACKENDS;

type BackendOverviewRow = {
  district: string;
  avg_temperature: number;
  avg_humidity: number;
  avg_cpu: number;
  avg_network: number;
  peak_cpu: number;
  samples: number;
};

type BackendQueryRow = {
  name: string;
  ms: number;
  rows: number;
};

type BackendComparison = {
  timescale: BackendResponse | null;
  plain: BackendResponse | null;
};

async function fetchBackendComparison(): Promise<BackendComparison> {
  const [timescale, plain] = await Promise.all([
    fetchBackendSnapshot("timescale"),
    fetchBackendSnapshot("plain"),
  ]);

  return { timescale, plain };
}

async function fetchBackendSnapshot(mode: BackendMode): Promise<BackendResponse | null> {
  try {
    const base = BACKENDS[mode];
    const [overviewRes, perfRes] = await Promise.all([
      fetch(`${base}/api/overview`),
      fetch(`${base}/api/queries/performance`),
    ]);

    if (!overviewRes.ok || !perfRes.ok) {
      return null;
    }

    const overview = (await overviewRes.json()) as { data?: BackendOverviewRow[]; mode?: BackendMode };
    const performance = (await perfRes.json()) as {
      averageMs?: number;
      queries?: BackendQueryRow[];
      benchmark?: { label?: string; summary?: string };
      mode?: BackendMode;
    };

    return {
      overview: overview.data ?? [],
      performance: {
        averageMs: performance.averageMs ?? 0,
        queries: performance.queries ?? [],
        benchmark: performance.benchmark ?? {},
      },
      mode,
    };
  } catch {
    return null;
  }
}

function buildBenchFromBackendData(backend: BackendResponse | null): { title: string; sql: string; rows: string; tsdb: number; pg: number }[] {
  if (!backend || backend.performance.queries.length === 0) {
    return [];
  }

  const plain = backend.mode === "plain" ? backend : null;
  const timescale = backend.mode === "timescale" ? backend : null;

  const tsdbMs = timescale?.performance.averageMs ?? 0;
  const pgMs = plain?.performance.averageMs ?? 0;

  return backend.performance.queries.map((query) => ({
    title: query.name === "rolling_window_avg" ? "Temperatura media por barrio" : query.name === "hot_spots" ? "Picos de contaminación" : "Consumo eléctrico (agregado continuo)",
    sql: query.name === "rolling_window_avg" ? "SELECT time_bucket('2 seconds', ts) ..." : query.name === "hot_spots" ? "SELECT district, MAX(cpu) ..." : "SELECT time_bucket('1 minute', ts) ...",
    rows: `${query.rows.toLocaleString("es-ES")} rows`,
    tsdb: backend.mode === "timescale" ? query.ms : tsdbMs || query.ms,
    pg: backend.mode === "plain" ? query.ms : pgMs || query.ms,
  }));
}

function mergeWithBackendState(base: SimState, backend: BackendResponse | null, mode: BackendMode): SimState {
  if (!backend) return base;

  const bench = buildBenchFromBackendData(backend);

  return {
    ...base,
    ingest: mode === "timescale" ? 52840 : 42120,
    totalRows: mode === "timescale" ? 4_983_662_130 : 3_512_404_900,
    chunks: mode === "timescale" ? 18432 : 4310,
    compression: mode === "timescale" ? 14.2 : 8.4,
    p95: Math.max(5, Number((backend.performance.averageMs || base.p95).toFixed(1))),
    bench: bench.length > 0 ? bench : base.bench,
    queryIdx: 0,
  };
}

function Clock() {
  const [now, setNow] = useState<string | null>(null);
  useEffect(() => {
    const f = () => setNow(new Date().toLocaleTimeString("es-ES", { hour12: false }));
    f();
    const id = setInterval(f, 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="text-foreground">{now ?? "--:--:--"}</span>;
}

function Dashboard() {
  const [running, setRunning] = useState(true);
  const [range, setRange] = useState<Range>("5m");
  const [focus, setFocus] = useState(0);
  const [backendMode, setBackendMode] = useState<BackendMode>("timescale");
  const [backendComparison, setBackendComparison] = useState<BackendComparison>({ timescale: null, plain: null });
  const baseSimulation = useSimulation(running);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const comparison = await fetchBackendComparison();
      if (!cancelled) setBackendComparison(comparison);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const activeBackend = backendMode === "timescale" ? backendComparison.timescale : backendComparison.plain;
  const s = mergeWithBackendState(baseSimulation, activeBackend, backendMode);
  const series = seriesFor(s, range);
  const last = s.history[s.history.length - 1]!;
  const otherBackendMode: BackendMode = backendMode === "timescale" ? "plain" : "timescale";
  const otherBackendSnapshot = backendComparison[otherBackendMode];
  const otherSeries = otherBackendSnapshot?.overview.length
    ? DISTRICTS.map((district) => {
        const row = otherBackendSnapshot.overview.find((item) => item.district === district);
        const value = row ? row.avg_temperature : 0;
        return { values: [value, value + 0.3, value + 0.7, value + 0.9, value + 0.5, value + 0.2], color: COLORS[0]! };
      })
    : DISTRICTS.map((district, idx) => ({
        values: series.map((r) => r.temp[district]).slice(-6),
        color: COLORS[idx % COLORS.length]!,
      }));

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 bg-glow" />
      <div className="relative flex min-h-screen">
        <aside className="hidden w-56 shrink-0 flex-col border-r bg-card/50 backdrop-blur-xl lg:flex">
          <div className="border-b px-5 py-5">
            <div className="flex items-center gap-2">
              <span className="tick size-2 rounded-full bg-primary" />
              <span className="font-display text-lg tracking-wide">PULSO</span>
              <span className="ml-auto font-mono text-[10px] text-dim">tsdb</span>
            </div>
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">sensores urbanos · tiempo real</p>
          </div>
          <nav className="space-y-1 px-3 py-4 text-[13px]">
            {NAV.map((n, i) => (
              <a
                key={n}
                className={
                  i === 0
                    ? "flex items-center gap-2.5 rounded-md bg-primary/10 px-3 py-2 font-medium text-primary"
                    : "flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
                }
              >
                <span className={`size-1.5 rounded-full ${i === 0 ? "bg-primary" : "bg-dim"}`} />
                {n}
              </a>
            ))}
          </nav>
          <div className="mx-3 mt-2 panel p-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-dim">Barrios</p>
            <ul className="mt-2 space-y-1.5 font-mono text-[11px]">
              {DISTRICTS.map((d, i) => (
                <li key={d} className="flex items-center gap-2">
                  <span className="size-1.5 rounded-full" style={{ background: COLORS[i] }} />
                  <span className="text-muted-foreground">{d}</span>
                  <span className="ml-auto tabular-nums">{last.temp[d].toFixed(1)}°</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="mt-auto border-t px-5 py-4">
            <p className="font-mono text-[10px] text-dim">SIMULADOR</p>
            <p className={`mt-1 flex items-center gap-2 font-mono text-[11px] ${running ? "text-pos" : "text-warn"}`}>
              <span className={`size-1.5 rounded-full ${running ? "tick bg-pos" : "bg-warn"}`} />
              {running ? "EN VIVO · 1 tick/s" : "EN PAUSA"}
            </p>
            <p className="mt-1 font-mono text-[10px] text-dim">{fmt(SENSORS)} sensores activos</p>
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 border-b bg-background/70 backdrop-blur-xl">
            <div className="flex flex-wrap items-center gap-4 px-5 py-3">
              <button
                onClick={() => setRunning((r) => !r)}
                className="flex items-center gap-2 rounded-md border px-2.5 py-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
              >
                <span className={`size-2 rounded-full ${running ? "tick bg-primary" : "bg-warn"}`} />
                {running ? "EN VIVO — pausar" : "PAUSADO — reanudar"}
              </button>
              <div className="hidden font-mono text-[11px] text-dim md:block">
                última inserción <Clock />
              </div>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1 rounded-md border bg-card/60 p-0.5 font-mono text-[11px]">
                  {(Object.keys(BACKENDS) as BackendMode[]).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => setBackendMode(mode)}
                      className={`rounded px-2.5 py-1 ${backendMode === mode ? "bg-primary/15 text-primary" : "text-dim hover:text-foreground"}`}
                    >
                      {mode === "timescale" ? "TimescaleDB" : "PostgreSQL"}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-1 rounded-md border bg-card/60 p-0.5 font-mono text-[11px]">
                  {(Object.keys(RANGES) as Range[]).map((r) => (
                    <button
                      key={r}
                      onClick={() => setRange(r)}
                      className={`rounded px-2.5 py-1 ${r === range ? "bg-primary/15 text-primary" : "text-dim hover:text-foreground"}`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </header>

          <div className="space-y-4 px-5 py-5">
            <StatStrip s={s} />

            <section className="rise panel overflow-hidden" style={{ animationDelay: "240ms" }}>
              <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
                <h2 className="font-display text-lg tracking-wide">Temperatura por barrio</h2>
                <span className="font-mono text-[10px] text-dim">
                  °C · time_bucket {RANGES[range].label} · ventana {range}
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-3 font-mono text-[10px]">
                  {DISTRICTS.map((d, i) => (
                    <button
                      key={d}
                      onClick={() => setFocus(i)}
                      className={`flex items-center gap-1.5 ${focus === i ? "text-foreground" : "text-muted-foreground"}`}
                    >
                      <span className="size-1.5 rounded-full" style={{ background: COLORS[i] }} />
                      {d}
                    </button>
                  ))}
                </div>
              </div>
              <div className="grid gap-4 p-3 xl:grid-cols-[minmax(0,1.75fr)_minmax(190px,0.55fr)]">
                <div className="relative h-64">
                  <LineChart
                    series={DISTRICTS.map((d, i) => ({
                      values: series.map((r) => r.temp[d]),
                      color: COLORS[i]!,
                    }))}
                  />
                  <div className="absolute right-4 top-3 font-mono text-[10px] text-primary">
                    {fmt(series.length)} buckets · {fmt(series.length * SENSORS)} lecturas
                  </div>
                </div>

                <div className="flex h-64 flex-col rounded-md border border-border/70 bg-card/35 p-2">
                  <div className="mb-2 flex items-center justify-between px-1 pt-1">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-dim">{otherBackendMode === "timescale" ? "TimescaleDB" : "PostgreSQL"}</span>
                    <span className="font-mono text-[9px] text-muted-foreground">mini</span>
                  </div>
                  <div className="flex-1">
                    <LineChart series={otherSeries} height={150} />
                  </div>
                </div>
              </div>
            </section>

            <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <MetricCard title="Humedad media" unit="%" value={last.humidity.toFixed(1)} values={series.map((r) => r.humidity)} color="var(--chart-2)" delay={280} />
              <MetricCard title="Calidad del aire" unit="AQI" value={String(last.aqi)} values={series.map((r) => r.aqi)} color={last.aqi > 100 ? "var(--neg)" : "var(--chart-3)"} delay={320} alert={last.aqi > 100} />
              <MetricCard title="Consumo eléctrico" unit="MW" value={last.energy.toFixed(1)} values={series.map((r) => r.energy)} color="var(--chart-5)" delay={360} />
              <MetricCard title="Ruido urbano" unit="dB" value={last.noise.toFixed(1)} values={series.map((r) => r.noise)} color="var(--chart-6)" delay={400} />
            </section>

            <section className="grid grid-cols-12 gap-4">
              <Drilldown s={s} focus={focus} range={range} />
              <QueryConsole s={s} range={range} />
            </section>

            <section className="grid grid-cols-12 gap-4">
              <Heatmap s={s} />
              <Feed s={s} />
            </section>

            <footer className="flex flex-wrap justify-between gap-2 border-t pt-4 font-mono text-[10px] text-dim">
              <span>PULSO · demo de rendimiento TimescaleDB · datos simulados por tareas programadas</span>
              <span>{fmt(s.totalRows)} filas en hipertabla readings</span>
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}

function StatStrip({ s }: { s: SimState }) {
  const items = [
    { k: "Filas / seg", v: fmt(s.ingest), sub: `${fmt(SENSORS)} sensores × 4 métricas`, d: "▲ ingesta", pos: true },
    { k: "Filas totales", v: `${(s.totalRows / 1e9).toFixed(3)} B`, sub: `${fmt(s.chunks)} chunks · 1 día/chunk`, d: "▲ creciendo", pos: true },
    { k: "Compresión", v: `${s.compression.toFixed(1)}×`, sub: "1,9 TB → 134 GB", d: "columnar", pos: true },
    { k: "Latencia p95", v: `${s.p95.toFixed(1)} ms`, sub: "consultas de agregación", d: s.p95 > 12 ? "▲ carga" : "▼ estable", pos: s.p95 <= 12 },
  ];
  return (
    <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
      {items.map((it, i) => (
        <div key={it.k} className="rise panel p-4" style={{ animationDelay: `${i * 60}ms` }}>
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-wider text-dim">{it.k}</span>
            <span className={`font-mono text-[10px] ${it.pos ? "text-pos" : "text-neg"}`}>{it.d}</span>
          </div>
          <div key={it.v} className="flash mt-2 font-mono text-2xl tabular-nums">{it.v}</div>
          <div className="mt-1 font-mono text-[10px] text-dim">{it.sub}</div>
        </div>
      ))}
    </section>
  );
}

function MetricCard({ title, unit, value, values, color, delay, alert }: { title: string; unit: string; value: string; values: number[]; color: string; delay: number; alert?: boolean }) {
  return (
    <div className="rise panel overflow-hidden" style={{ animationDelay: `${delay}ms` }}>
      <div className="flex items-center justify-between px-4 pt-3">
        <span className="font-mono text-[10px] uppercase tracking-wider text-dim">{title}</span>
        {alert && <span className="tick rounded bg-neg/15 px-1.5 py-0.5 font-mono text-[9px] text-neg">ALERTA</span>}
      </div>
      <div className="flex items-baseline gap-1 px-4 pt-1">
        <span className="font-mono text-xl tabular-nums">{value}</span>
        <span className="font-mono text-[10px] text-muted-foreground">{unit}</span>
      </div>
      <div className="h-14">
        <Sparkline values={values} color={color} />
      </div>
    </div>
  );
}

function Drilldown({ s, focus, range }: { s: SimState; focus: number; range: Range }) {
  const d = DISTRICTS[focus]!;
  const series = seriesFor(s, range).map((r) => r.temp[d]);
  const size = Math.max(1, Math.floor(series.length / 16));
  const buckets: number[] = [];
  for (let i = 0; i + size <= series.length; i += size) {
    const chunk = series.slice(i, i + size);
    buckets.push(chunk.reduce((a, b) => a + b, 0) / chunk.length);
  }
  const b = buckets.slice(-16);
  const avg = series.reduce((a, x) => a + x, 0) / series.length;
  return (
    <div className="rise panel col-span-12 lg:col-span-5" style={{ animationDelay: "300ms" }}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h3 className="font-display text-base tracking-wide">Detalle · {d}</h3>
        <span className="ml-auto font-mono text-[10px] text-dim">avg() · 16 buckets</span>
      </div>
      <div className="p-4">
        <div className="h-28">
          <Bars values={b} color={COLORS[focus]!} />
        </div>
        <div className="mt-2 flex justify-between font-mono text-[9px] text-dim">
          <span>-{range}</span>
          <span>ahora</span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 font-mono text-[11px]">
          <div><p className="text-[10px] text-dim">media</p><p className="tabular-nums">{avg.toFixed(2)} °C</p></div>
          <div><p className="text-[10px] text-dim">máx</p><p className="tabular-nums">{Math.max(...series).toFixed(2)} °C</p></div>
          <div><p className="text-[10px] text-dim">mín</p><p className="tabular-nums">{Math.min(...series).toFixed(2)} °C</p></div>
        </div>
        <p className="mt-3 font-mono text-[10px] text-dim">Pulsa un barrio en la gráfica principal para ver su detalle.</p>
      </div>
    </div>
  );
}

function QueryConsole({ s, range }: { s: SimState; range: Range }) {
  const q = s.bench[s.queryIdx]!;
  const sql = q.sql.replace("{bucket}", RANGES[range].bucket).replace("{interval}", RANGES[range].interval);
  const speed = q.pg / q.tsdb;
  return (
    <div className="rise panel col-span-12 lg:col-span-7" style={{ animationDelay: "360ms" }}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h3 className="font-display text-base tracking-wide">Consola de consultas</h3>
        <span className="ml-auto font-mono text-[10px] text-dim">TimescaleDB vs PostgreSQL</span>
      </div>
      <div className="p-4 font-mono text-[12px] leading-relaxed">
        <div className="mb-2 flex gap-1">
          {s.bench.map((b, i) => (
            <span key={b.title} className={`h-1 flex-1 rounded-full ${i === s.queryIdx ? "bg-primary" : "bg-border"}`} />
          ))}
        </div>
        <p className="text-dim">-- {q.title} · escanea {q.rows} filas</p>
        <pre key={s.queryIdx} className="slidein whitespace-pre-wrap text-foreground">{sql}</pre>
        <div className="mt-4 space-y-2">
          <BenchRow label="TimescaleDB" ms={q.tsdb} pct={(q.tsdb / q.pg) * 100} tone="pos" />
          <BenchRow label="PostgreSQL" ms={q.pg} pct={100} tone="neg" />
        </div>
        <p className="mt-3 text-[10px] text-dim">
          aceleración <span className="text-pos">{speed.toFixed(0)}×</span> · compresión <span className="text-pos">{s.compression.toFixed(1)}×</span> · chunk exclusion activo
        </p>
      </div>
    </div>
  );
}

function BenchRow({ label, ms, pct, tone }: { label: string; ms: number; pct: number; tone: "pos" | "neg" }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-[10px] text-muted-foreground">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border/60">
        <div className={`h-full rounded-full transition-[width] duration-500 ${tone === "pos" ? "bg-pos" : "bg-neg/70"}`} style={{ width: `${Math.max(2, pct)}%` }} />
      </div>
      <span className={`w-20 text-right tabular-nums ${tone === "pos" ? "text-pos" : "text-neg"}`}>
        {ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`}
      </span>
    </div>
  );
}

function Heatmap({ s }: { s: SimState }) {
  const all = s.heat.flat();
  const min = Math.min(...all);
  const max = Math.max(...all);
  return (
    <div className="rise panel col-span-12 lg:col-span-8" style={{ animationDelay: "420ms" }}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h3 className="font-display text-base tracking-wide">Mapa de calor · últimas 24 h</h3>
        <span className="ml-auto font-mono text-[10px] text-dim">agregado continuo temp_hourly</span>
      </div>
      <div className="overflow-x-auto p-4">
        <div className="min-w-[560px] space-y-1">
          {DISTRICTS.map((d, di) => (
            <div key={d} className="flex items-center gap-2">
              <span className="w-14 shrink-0 font-mono text-[10px] text-muted-foreground">{d}</span>
              <div className="grid flex-1 grid-cols-24 gap-[2px]" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}>
                {s.heat[di]!.map((v, h) => {
                  const t = (v - min) / (max - min || 1);
                  return (
                    <div
                      key={h}
                      title={`${d} ${h}:00 · ${v} °C`}
                      className="h-6 rounded-[2px]"
                      style={{ background: `color-mix(in oklab, var(--chart-4) ${Math.round(t * 100)}%, var(--info))`, opacity: 0.35 + t * 0.65 }}
                    />
                  );
                })}
              </div>
            </div>
          ))}
          <div className="flex gap-2 pl-16 font-mono text-[9px] text-dim">
            <div className="flex flex-1 justify-between"><span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>23h</span></div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Feed({ s }: { s: SimState }) {
  return (
    <div className="rise panel col-span-12 lg:col-span-4" style={{ animationDelay: "480ms" }}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h3 className="font-display text-base tracking-wide">Inserciones en vivo</h3>
        <span className="tick ml-auto size-1.5 rounded-full bg-primary" />
      </div>
      <ul className="h-[228px] overflow-hidden px-4 py-2 font-mono text-[11px]">
        {s.feed.length === 0 && <li className="py-2 text-dim">Esperando datos…</li>}
        {s.feed.map((f) => (
          <li key={f.id} className="slidein flex items-center gap-2 border-b border-border/40 py-1.5">
            <span className="text-primary">INSERT</span>
            <span className="text-muted-foreground">{f.sensor}</span>
            <span className="text-dim">{f.metric}</span>
            <span className="ml-auto tabular-nums">{f.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
