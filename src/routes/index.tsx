import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Bars, LineChart, Sparkline } from "@/components/charts";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PULSO — Sensores urbanos en tiempo real con TimescaleDB" },
      {
        name: "description",
        content: "Datos de sensores consultados desde PostgreSQL y TimescaleDB.",
      },
      { property: "og:title", content: "PULSO — Sensores urbanos en tiempo real" },
      {
        property: "og:description",
        content: "Datos de sensores consultados desde PostgreSQL y TimescaleDB.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
});

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];
const NAV = ["Resumen", "Sensores", "Consultas", "Alertas", "Mapa"];
const BACKENDS = {
  timescale: "http://localhost:4002",
  plain: "http://localhost:4001",
} as const;
const RANGES = {
  "1m": "1 s",
  "5m": "2 s",
  "1h": "1 min",
  "24h": "15 min",
  "7d": "2 h",
} as const;

type BackendMode = keyof typeof BACKENDS;
type Range = keyof typeof RANGES;
type MetricKey = "temperature" | "humidity" | "cpu" | "memory" | "network";

type OverviewRow = {
  district: string;
  avg_temperature: number | null;
  avg_humidity: number | null;
  avg_cpu: number | null;
  avg_memory: number | null;
  avg_network: number | null;
  peak_cpu: number | null;
  samples: number;
  humidity_samples: number;
  cpu_samples: number;
  memory_samples: number;
  network_samples: number;
};

type SeriesRow = {
  bucket: string;
  district: string;
} & Record<MetricKey, number | null> &
  Record<`${MetricKey}_samples`, number>;

type FeedRow = {
  ts: string;
  sensor_id: string;
  district: string;
  metric: string;
  value: number;
};

type DashboardData = {
  mode: BackendMode;
  database: string;
  range: Range;
  stats: {
    lastReadingAt: string | null;
  };
  overview: OverviewRow[];
  series: SeriesRow[];
  heatmap: { district: string; bucket: number; temperature: number | null; samples: number }[];
  feed: FeedRow[];
};

type QueryResult = { name: string; title: string; ms: number; rows: number; sql: string };
type PerformanceData = { averageMs: number; queries: QueryResult[] };
type BackendSnapshot = {
  dashboard: DashboardData | null;
  performance: PerformanceData | null;
  error: string | null;
  performanceError: string | null;
};
type BackendComparison = Record<BackendMode, BackendSnapshot>;

const emptySnapshot = (): BackendSnapshot => ({
  dashboard: null,
  performance: null,
  error: null,
  performanceError: null,
});

function formatNumber(value: number, decimals = 0) {
  return value.toLocaleString("es-ES", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

async function fetchBackendSnapshot(
  mode: BackendMode,
  range: Range,
  includePerformance: boolean,
): Promise<BackendSnapshot> {
  try {
    const base = BACKENDS[mode];
    const [dashboardResult, performanceResult] = await Promise.allSettled([
      fetch(`${base}/api/dashboard?range=${range}`),
      includePerformance ? fetch(`${base}/api/queries/performance`) : Promise.resolve(null),
    ]);
    if (dashboardResult.status === "rejected") throw dashboardResult.reason;
    if (!dashboardResult.value.ok) {
      throw new Error(`Dashboard: HTTP ${dashboardResult.value.status}`);
    }

    const dashboard = (await dashboardResult.value.json()) as DashboardData;
    if (dashboard.mode !== mode) {
      throw new Error(`La API devolvió el modo ${dashboard.mode}, se esperaba ${mode}`);
    }
    let performance: PerformanceData | null = null;
    let performanceError: string | null = null;
    if (!includePerformance) {
      return { dashboard, performance, error: null, performanceError };
    }
    if (performanceResult.status === "rejected") {
      performanceError =
        performanceResult.reason instanceof Error
          ? performanceResult.reason.message
          : "Error desconocido";
    } else if (performanceResult.value === null) {
      performanceError = "No se recibió la respuesta de rendimiento";
    } else if (!performanceResult.value.ok) {
      performanceError = `HTTP ${performanceResult.value.status}`;
    } else {
      try {
        performance = (await performanceResult.value.json()) as PerformanceData;
      } catch (error) {
        performanceError =
          error instanceof Error ? error.message : "Respuesta de rendimiento no válida";
      }
    }
    return { dashboard, performance, error: null, performanceError };
  } catch (error) {
    return {
      dashboard: null,
      performance: null,
      error:
        error instanceof Error ? error.message : "Error desconocido al consultar la base de datos",
      performanceError: null,
    };
  }
}

function mergeSnapshot(previous: BackendSnapshot, next: BackendSnapshot): BackendSnapshot {
  return {
    ...next,
    performance: next.performance ?? previous.performance,
    performanceError:
      next.performance !== null ? null : (next.performanceError ?? previous.performanceError),
  };
}

function Clock({ value }: { value: string | null }) {
  return (
    <span className="text-foreground">
      {value ? new Date(value).toLocaleTimeString("es-ES", { hour12: false }) : "sin lecturas"}
    </span>
  );
}

function Dashboard() {
  const [range, setRange] = useState<Range>("5m");
  const [focus, setFocus] = useState(0);
  const [backendMode, setBackendMode] = useState<BackendMode>("timescale");
  const [backendComparison, setBackendComparison] = useState<BackendComparison>({
    timescale: emptySnapshot(),
    plain: emptySnapshot(),
  });

  useEffect(() => {
    let cancelled = false;
    const refreshInProgress: Record<BackendMode, boolean> = { timescale: false, plain: false };
    const pendingRefresh: Record<BackendMode, boolean> = { timescale: false, plain: false };
    const refresh = async (mode: BackendMode, includePerformance: boolean) => {
      if (refreshInProgress[mode]) {
        pendingRefresh[mode] = true;
        return;
      }
      refreshInProgress[mode] = true;
      try {
        const snapshot = await fetchBackendSnapshot(mode, range, includePerformance);
        if (!cancelled) {
          setBackendComparison((previous) => ({
            ...previous,
            [mode]: mergeSnapshot(previous[mode], snapshot),
          }));
        }
      } finally {
        refreshInProgress[mode] = false;
        if (!cancelled && pendingRefresh[mode]) {
          pendingRefresh[mode] = false;
          void refresh(mode, false);
        }
      }
    };

    const streams = (Object.keys(BACKENDS) as BackendMode[]).map((mode) => {
      void refresh(mode, true);
      const stream = new EventSource(`${BACKENDS[mode]}/api/events`);
      stream.addEventListener("readings-inserted", () => {
        void refresh(mode, false);
      });
      return stream;
    });
    const benchmarkRefresh = window.setInterval(() => {
      for (const mode of Object.keys(BACKENDS) as BackendMode[]) {
        void refresh(mode, true);
      }
    }, 30000);

    return () => {
      cancelled = true;
      window.clearInterval(benchmarkRefresh);
      streams.forEach((stream) => stream.close());
    };
  }, [range]);

  const activeSnapshot = backendComparison[backendMode];
  const otherBackendMode: BackendMode = backendMode === "timescale" ? "plain" : "timescale";
  const otherSnapshot = backendComparison[otherBackendMode];
  const data = activeSnapshot.dashboard;
  const otherData = otherSnapshot.dashboard;
  const districts = useMemo(() => data?.overview.map((row) => row.district) ?? [], [data]);
  const selectedDistrict = districts[Math.min(focus, Math.max(districts.length - 1, 0))] ?? "";

  const districtSeries = useMemo(() => {
    const rowsByDistrict = new Map<string, SeriesRow[]>();
    for (const row of data?.series ?? []) {
      const rows = rowsByDistrict.get(row.district) ?? [];
      rows.push(row);
      rowsByDistrict.set(row.district, rows);
    }
    return districts.map((district, index) => ({
      label: district,
      color: COLORS[index % COLORS.length]!,
      values: (rowsByDistrict.get(district) ?? []).flatMap((row) =>
        row.temperature === null ? [] : [row.temperature],
      ),
    }));
  }, [data, districts]);

  const otherDistrictSeries = useMemo(() => {
    const rowsByDistrict = new Map<string, SeriesRow[]>();
    for (const row of otherData?.series ?? []) {
      const rows = rowsByDistrict.get(row.district) ?? [];
      rows.push(row);
      rowsByDistrict.set(row.district, rows);
    }
    return (otherData?.overview ?? []).map((row, index) => ({
      label: row.district,
      color: COLORS[index % COLORS.length]!,
      values: (rowsByDistrict.get(row.district) ?? []).flatMap((sample) =>
        sample.temperature === null ? [] : [sample.temperature],
      ),
    }));
  }, [otherData]);

  const lastDistrict = data?.overview.find((row) => row.district === selectedDistrict);
  const selectedDistrictSeries =
    data?.series.filter((row) => row.district === selectedDistrict) ?? [];
  const selectedTemps = selectedDistrictSeries.flatMap((row) =>
    row.temperature === null ? [] : [row.temperature],
  );
  const benchmarks = useMemo(() => {
    const activeQueries = activeSnapshot.performance?.queries ?? [];
    const otherQueries = otherSnapshot.performance?.queries ?? [];
    const names = [...new Set([...activeQueries, ...otherQueries].map((query) => query.name))];
    return names.flatMap((name) => {
      const active = activeQueries.find((query) => query.name === name) ?? null;
      const other = otherQueries.find((query) => query.name === name) ?? null;
      return active || other ? [{ name, active, other }] : [];
    });
  }, [activeSnapshot.performance, otherSnapshot.performance]);

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      <div className="pointer-events-none fixed inset-0 bg-glow" />
      <div className="relative flex min-h-screen">
        <aside className="hidden w-56 shrink-0 flex-col border-r bg-card/50 backdrop-blur-xl lg:flex">
          <div className="border-b px-5 py-5">
            <div className="flex items-center gap-2">
              <span className={`size-2 rounded-full ${data ? "tick bg-pos" : "bg-neg"}`} />
              <span className="font-display text-lg tracking-wide">PULSO</span>
              <span className="ml-auto font-mono text-[10px] text-dim">tsdb</span>
            </div>
            <p className="mt-1 font-mono text-[10px] text-muted-foreground">
              lecturas desde la base de datos
            </p>
          </div>
          <nav className="space-y-1 px-3 py-4 text-[13px]">
            {NAV.map((item, index) => (
              <a
                key={item}
                className={
                  index === 0
                    ? "flex items-center gap-2.5 rounded-md bg-primary/10 px-3 py-2 font-medium text-primary"
                    : "flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
                }
              >
                <span
                  className={`size-1.5 rounded-full ${index === 0 ? "bg-primary" : "bg-dim"}`}
                />
                {item}
              </a>
            ))}
          </nav>
          <div className="mx-3 mt-2 panel p-3">
            <p className="font-mono text-[10px] uppercase tracking-wider text-dim">
              Barrios · promedio 5 min
            </p>
            {districts.length === 0 ? (
              <p className="mt-2 font-mono text-[11px] text-dim">Sin datos en la base</p>
            ) : (
              <ul className="mt-2 space-y-1.5 font-mono text-[11px]">
                {data?.overview.map((row, index) => (
                  <li key={row.district} className="flex items-center gap-2">
                    <span
                      className="size-1.5 rounded-full"
                      style={{ background: COLORS[index % COLORS.length] }}
                    />
                    <span className="text-muted-foreground">{row.district}</span>
                    <span className="ml-auto tabular-nums">
                      {row.avg_temperature === null ? "—" : `${row.avg_temperature.toFixed(1)}°`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mt-auto border-t px-5 py-4">
            <p className="font-mono text-[10px] text-dim">FUENTE ACTIVA</p>
            <p
              className={`mt-1 flex items-center gap-2 font-mono text-[11px] ${data ? "text-pos" : "text-neg"}`}
            >
              <span className={`size-1.5 rounded-full ${data ? "tick bg-pos" : "bg-neg"}`} />
              {data?.database ?? (activeSnapshot.error ? "SIN CONEXIÓN" : "CONECTANDO")}
            </p>
            {activeSnapshot.error && (
              <p className="mt-1 break-words font-mono text-[10px] text-neg">
                {activeSnapshot.error}
              </p>
            )}
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 border-b bg-background/70 backdrop-blur-xl">
            <div className="flex flex-wrap items-center gap-4 px-5 py-3">
              <div className="font-mono text-[11px] text-dim">
                última lectura en la base <Clock value={data?.stats.lastReadingAt ?? null} />
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
                  {(Object.keys(RANGES) as Range[]).map((item) => (
                    <button
                      key={item}
                      onClick={() => setRange(item)}
                      className={`rounded px-2.5 py-1 ${item === range ? "bg-primary/15 text-primary" : "text-dim hover:text-foreground"}`}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </header>

          <div className="space-y-4 px-5 py-5">
            {!data && <DatabaseMessage error={activeSnapshot.error} />}
            {data && (
              <>
                <section className="rise panel overflow-hidden" style={{ animationDelay: "240ms" }}>
                  <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3">
                    <h2 className="font-display text-lg tracking-wide">Temperatura por barrio</h2>
                    <span className="font-mono text-[10px] text-dim">
                      °C · bucket {RANGES[range]} · ventana {range}
                    </span>
                    <div className="ml-auto flex flex-wrap items-center gap-3 font-mono text-[10px]">
                      {districts.map((district, index) => (
                        <button
                          key={district}
                          onClick={() => setFocus(index)}
                          className={`flex items-center gap-1.5 ${focus === index ? "text-foreground" : "text-muted-foreground"}`}
                        >
                          <span
                            className="size-1.5 rounded-full"
                            style={{ background: COLORS[index % COLORS.length] }}
                          />
                          {district}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="grid gap-4 p-3 xl:grid-cols-[minmax(0,1.75fr)_minmax(190px,0.55fr)]">
                    <div className="relative h-64">
                      {districtSeries.some((line) => line.values.length > 0) ? (
                        <LineChart series={districtSeries} />
                      ) : (
                        <EmptyState text="No hay lecturas de temperatura en este intervalo." />
                      )}
                      <div className="absolute right-4 top-3 font-mono text-[10px] text-primary">
                        {formatNumber(data.series.length)} registros agregados desde la base
                      </div>
                    </div>
                    <div className="flex h-64 flex-col rounded-md border border-border/70 bg-card/35 p-2">
                      <div className="mb-2 flex items-center justify-between px-1 pt-1">
                        <span className="font-mono text-[10px] uppercase tracking-wider text-dim">
                          {otherData?.database ??
                            (otherSnapshot.error ? "Base no disponible" : "Conectando…")}
                        </span>
                        <span className="font-mono text-[9px] text-muted-foreground">
                          comparación
                        </span>
                      </div>
                      <div className="flex-1">
                        {otherData && otherDistrictSeries.some((line) => line.values.length > 0) ? (
                          <LineChart series={otherDistrictSeries} height={150} />
                        ) : (
                          <EmptyState
                            text={otherSnapshot.error ?? "Esperando lecturas de la otra base."}
                          />
                        )}
                      </div>
                    </div>
                  </div>
                </section>

                <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
                  {(
                    [
                      ["Humedad media", "humidity", "%", "var(--chart-2)"],
                      ["CPU media", "cpu", "%", "var(--chart-3)"],
                      ["Memoria media", "memory", "%", "var(--chart-5)"],
                      ["Red media", "network", "Mbps", "var(--chart-6)"],
                    ] as const
                  ).map(([title, metric, unit, color], index) => {
                    const value = overviewAverage(data.overview, metric);
                    const values = aggregateSeries(data.series, metric);
                    return (
                      <MetricCard
                        key={metric}
                        title={title}
                        unit={unit}
                        value={value}
                        values={values}
                        color={color}
                        delay={280 + index * 40}
                      />
                    );
                  })}
                </section>

                <section className="grid grid-cols-12 gap-4">
                  <Drilldown
                    district={selectedDistrict}
                    overview={lastDistrict}
                    values={selectedTemps}
                    range={range}
                    focus={focus}
                  />
                  <QueryConsole
                    queries={benchmarks}
                    mode={backendMode}
                    otherMode={otherBackendMode}
                    performanceError={activeSnapshot.performanceError}
                  />
                </section>

                <section className="grid grid-cols-12 gap-4">
                  <Heatmap data={data} />
                  <Feed data={data} />
                </section>
              </>
            )}

            <footer className="flex flex-wrap justify-between gap-2 border-t pt-4 font-mono text-[10px] text-dim">
              <span>PULSO · lecturas y agregados consultados desde las bases configuradas</span>
              <span>
                {data
                  ? `${data.database} · transmisión en vivo`
                  : "sin datos de la base seleccionada"}
              </span>
            </footer>
          </div>
        </main>
      </div>
    </div>
  );
}

function DatabaseMessage({ error }: { error: string | null }) {
  return (
    <div className="panel p-6 font-mono text-sm">
      <p className="text-neg">
        {error
          ? `No se pudieron consultar los datos: ${error}`
          : "Conectando con la base de datos…"}
      </p>
      {error && (
        <p className="mt-2 text-dim">
          No se muestran datos de ejemplo. Comprueba que Docker Compose y la API estén en ejecución.
        </p>
      )}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center px-4 text-center font-mono text-[11px] text-dim">
      {text}
    </div>
  );
}

function aggregateSeries(rows: SeriesRow[], metric: MetricKey) {
  const buckets = new Map<string, { weightedSum: number; count: number }>();
  for (const row of rows) {
    const value = row[metric];
    const count = row[`${metric}_samples`];
    if (value === null || count === 0) continue;
    const aggregate = buckets.get(row.bucket) ?? { weightedSum: 0, count: 0 };
    aggregate.weightedSum += value * count;
    aggregate.count += count;
    buckets.set(row.bucket, aggregate);
  }
  return [...buckets.values()].map((item) => item.weightedSum / item.count);
}

function overviewAverage(rows: OverviewRow[], metric: Exclude<MetricKey, "temperature">) {
  const samplesKey = `${metric}_samples` as const;
  const totalSamples = rows.reduce((sum, row) => sum + row[samplesKey], 0);
  if (totalSamples === 0) return null;
  return (
    rows.reduce((sum, row) => sum + (row[`avg_${metric}`] ?? 0) * row[samplesKey], 0) / totalSamples
  );
}

function MetricCard({
  title,
  unit,
  value,
  values,
  color,
  delay,
}: {
  title: string;
  unit: string;
  value: number | null;
  values: number[];
  color: string;
  delay: number;
}) {
  return (
    <div className="rise panel overflow-hidden" style={{ animationDelay: `${delay}ms` }}>
      <div className="px-4 pt-3 font-mono text-[10px] uppercase tracking-wider text-dim">
        {title}
      </div>
      <div className="flex items-baseline gap-1 px-4 pt-1">
        <span className="font-mono text-xl tabular-nums">
          {value === null || Number.isNaN(value) ? "—" : value.toFixed(1)}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{unit}</span>
      </div>
      <div className="h-14">
        {values.length > 0 ? (
          <Sparkline values={values} color={color} />
        ) : (
          <EmptyState text="Sin lecturas" />
        )}
      </div>
    </div>
  );
}

function Drilldown({
  district,
  overview,
  values,
  range,
  focus,
}: {
  district: string;
  overview: OverviewRow | undefined;
  values: number[];
  range: Range;
  focus: number;
}) {
  const size = Math.max(1, Math.floor(values.length / 16));
  const buckets: number[] = [];
  for (let i = 0; i + size <= values.length; i += size) {
    const group = values.slice(i, i + size);
    buckets.push(group.reduce((sum, value) => sum + value, 0) / group.length);
  }
  const average = overview?.avg_temperature;
  return (
    <div className="rise panel col-span-12 lg:col-span-5" style={{ animationDelay: "300ms" }}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h3 className="font-display text-base tracking-wide">
          Detalle · {district || "sin barrio"}
        </h3>
        <span className="ml-auto font-mono text-[10px] text-dim">temperatura leída de la base</span>
      </div>
      <div className="p-4">
        <div className="h-28">
          {buckets.length > 0 ? (
            <Bars values={buckets} color={COLORS[focus % COLORS.length]!} />
          ) : (
            <EmptyState text="Sin temperaturas para mostrar." />
          )}
        </div>
        <div className="mt-2 flex justify-between font-mono text-[9px] text-dim">
          <span>-{range}</span>
          <span>último bucket</span>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 font-mono text-[11px]">
          <div>
            <p className="text-[10px] text-dim">media 5 min</p>
            <p className="tabular-nums">
              {average === null || average === undefined ? "—" : `${average.toFixed(2)} °C`}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-dim">máx intervalo</p>
            <p className="tabular-nums">
              {values.length ? `${Math.max(...values).toFixed(2)} °C` : "—"}
            </p>
          </div>
          <div>
            <p className="text-[10px] text-dim">mín intervalo</p>
            <p className="tabular-nums">
              {values.length ? `${Math.min(...values).toFixed(2)} °C` : "—"}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function QueryConsole({
  queries,
  mode,
  otherMode,
  performanceError,
}: {
  queries: { name: string; active: QueryResult | null; other: QueryResult | null }[];
  mode: BackendMode;
  otherMode: BackendMode;
  performanceError: string | null;
}) {
  return (
    <div className="rise panel col-span-12 lg:col-span-7" style={{ animationDelay: "360ms" }}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h3 className="font-display text-base tracking-wide">Consola de consultas</h3>
        <span className="ml-auto font-mono text-[10px] text-dim">
          Ejecución medida por cada base (EXPLAIN ANALYZE)
        </span>
      </div>
      {queries.length === 0 ? (
        <EmptyState
          text={
            performanceError
              ? `No se pudieron medir las consultas: ${performanceError}`
              : "Sin resultados de consulta disponibles."
          }
        />
      ) : (
        <div className="space-y-3 p-4">
          {queries.map(({ name, active, other }) => {
            const title = active?.title ?? other?.title ?? name;
            const maxMs = Math.max(active?.ms ?? 0, other?.ms ?? 0);
            return (
              <section key={name} className="rounded-md border border-border/70 bg-card/30 p-3">
                <h4 className="mb-3 font-mono text-[11px] text-dim">{title}</h4>
                <div className="grid gap-3 xl:grid-cols-2">
                  <QuerySide
                    label={mode === "timescale" ? "TimescaleDB" : "PostgreSQL"}
                    query={active}
                    maxMs={maxMs}
                  />
                  <QuerySide
                    label={otherMode === "timescale" ? "TimescaleDB" : "PostgreSQL"}
                    query={other}
                    maxMs={maxMs}
                  />
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function QuerySide({
  label,
  query,
  maxMs,
}: {
  label: string;
  query: QueryResult | null;
  maxMs: number;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2 font-mono text-[10px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-dim">
          {query ? `${formatNumber(query.rows)} filas` : "sin medición"}
        </span>
      </div>
      {query ? (
        <>
          <pre className="max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-background/70 p-2 font-mono text-[10px] leading-relaxed text-foreground">
            {query.sql}
          </pre>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border/60">
              <div
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.max(2, (query.ms / (maxMs || 1)) * 100)}%` }}
              />
            </div>
            <span className="w-20 text-right font-mono text-[10px] tabular-nums">
              {query.ms >= 1000 ? `${(query.ms / 1000).toFixed(2)} s` : `${query.ms} ms`}
            </span>
          </div>
        </>
      ) : (
        <p className="rounded bg-background/70 p-2 font-mono text-[10px] text-dim">
          No se recibieron datos de esta consulta.
        </p>
      )}
    </div>
  );
}

function Heatmap({ data }: { data: DashboardData }) {
  const values = data.heatmap.flatMap((item) =>
    item.temperature === null ? [] : [item.temperature],
  );
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const districts = data.overview.map((row) => row.district);
  const currentMinute = Math.floor(Date.now() / 60000) * 60000;
  const bucketTimes = Array.from({ length: 5 }, (_, index) => currentMinute - (4 - index) * 60000);
  return (
    <div className="rise panel col-span-12 lg:col-span-8" style={{ animationDelay: "420ms" }}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h3 className="font-display text-base tracking-wide">Mapa de calor · últimos 5 min</h3>
        <span className="ml-auto font-mono text-[10px] text-dim">
          promedios por minuto consultados en la base
        </span>
      </div>
      {values.length === 0 ? (
        <EmptyState text="No hay lecturas de temperatura en los últimos 5 minutos." />
      ) : (
        <div className="overflow-x-auto p-4">
          <div className="min-w-[560px] space-y-1">
            {districts.map((district) => (
              <div key={district} className="flex items-center gap-2">
                <span className="w-14 shrink-0 font-mono text-[10px] text-muted-foreground">
                  {district}
                </span>
                <div
                  className="grid flex-1 gap-[2px]"
                  style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}
                >
                  {bucketTimes.map((bucket) => {
                    const cell = data.heatmap.find(
                      (item) => item.district === district && item.bucket === bucket,
                    );
                    const temperature = cell?.temperature ?? null;
                    const ratio = temperature === null ? 0 : (temperature - min) / (max - min || 1);
                    const time = new Date(bucket).toLocaleTimeString("es-ES", {
                      hour: "2-digit",
                      minute: "2-digit",
                    });
                    return (
                      <div
                        key={bucket}
                        title={
                          temperature === null
                            ? `${district} ${time} · sin lecturas`
                            : `${district} ${time} · ${temperature.toFixed(1)} °C · ${formatNumber(cell?.samples ?? 0)} muestras`
                        }
                        className={`h-6 rounded-[2px] ${temperature === null ? "bg-border/40" : ""}`}
                        style={
                          temperature === null
                            ? undefined
                            : {
                                background: `color-mix(in oklab, var(--chart-4) ${Math.round(ratio * 100)}%, var(--info))`,
                                opacity: 0.35 + ratio * 0.65,
                              }
                        }
                      />
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="flex gap-2 pl-16 font-mono text-[9px] text-dim">
              <div className="flex flex-1 justify-between">
                <span>−4 min</span>
                <span>−2 min</span>
                <span>ahora</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Feed({ data }: { data: DashboardData }) {
  return (
    <div className="rise panel col-span-12 lg:col-span-4" style={{ animationDelay: "480ms" }}>
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <h3 className="font-display text-base tracking-wide">Últimas lecturas</h3>
        <span className="ml-auto font-mono text-[9px] text-dim">{data.database}</span>
      </div>
      <ul className="h-[228px] overflow-auto px-4 py-2 font-mono text-[11px]">
        {data.feed.length === 0 && (
          <li className="py-2 text-dim">La base todavía no contiene lecturas.</li>
        )}
        {data.feed.map((row, index) => (
          <li
            key={`${row.ts}-${row.sensor_id}-${row.metric}-${index}`}
            className="flex items-center gap-2 border-b border-border/40 py-1.5"
          >
            <span className="text-primary">{row.metric}</span>
            <span className="text-muted-foreground">{row.sensor_id}</span>
            <span className="text-dim">{row.district}</span>
            <span className="ml-auto tabular-nums">{formatNumber(row.value, 2)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
