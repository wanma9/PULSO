import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PULSO — PostgreSQL y TimescaleDB" },
      {
        name: "description",
        content: "Comparación de datos y rendimiento entre PostgreSQL y TimescaleDB.",
      },
    ],
  }),
  component: Dashboard,
});

const BACKENDS = {
  timescale: {
    label: "TimescaleDB",
    url: import.meta.env.VITE_API_TIMESCALE_URL ?? "http://localhost:4002",
    accent: "var(--chart-1)",
  },
  plain: {
    label: "PostgreSQL",
    url: import.meta.env.VITE_API_POSTGRES_URL ?? "http://localhost:4001",
    accent: "var(--chart-4)",
  },
} as const;

type BackendMode = keyof typeof BACKENDS;
type OverviewRow = {
  district: string;
  avg_temperature: number | null;
  avg_humidity: number | null;
  avg_cpu: number | null;
  samples: number;
};
type QueryResult = { name: string; title: string; ms: number; rows: number };
type BackendSnapshot = {
  overview: OverviewRow[];
  performance: { averageMs: number; queries: QueryResult[] };
  fetchedAt: string;
};
type BackendState = { snapshot: BackendSnapshot | null; error: string | null };
type ComparisonState = Record<BackendMode, BackendState>;

const EMPTY_STATE: ComparisonState = {
  timescale: { snapshot: null, error: null },
  plain: { snapshot: null, error: null },
};

async function fetchBackend(mode: BackendMode): Promise<BackendSnapshot> {
  const base = BACKENDS[mode].url;
  const [overviewRes, performanceRes] = await Promise.all([
    fetch(`${base}/api/overview`, { signal: AbortSignal.timeout(30_000) }),
    fetch(`${base}/api/queries/performance`, { signal: AbortSignal.timeout(30_000) }),
  ]);
  if (!overviewRes.ok || !performanceRes.ok) {
    throw new Error(`La API respondió con error (${overviewRes.status}/${performanceRes.status})`);
  }

  const overview = (await overviewRes.json()) as { data?: Array<Record<string, unknown>> };
  const performance = (await performanceRes.json()) as {
    averageMs?: number;
    queries?: QueryResult[];
  };

  return {
    overview: (overview.data ?? []).map((row) => ({
      district: String(row.district ?? "Sin barrio"),
      avg_temperature: nullableNumber(row.avg_temperature),
      avg_humidity: nullableNumber(row.avg_humidity),
      avg_cpu: nullableNumber(row.avg_cpu),
      samples: Number(row.samples ?? 0),
    })),
    performance: {
      averageMs: Number(performance.averageMs ?? 0),
      queries: performance.queries ?? [],
    },
    fetchedAt: new Date().toLocaleTimeString("es-ES", { hour12: false }),
  };
}

function Dashboard() {
  const [comparison, setComparison] = useState<ComparisonState>(EMPTY_STATE);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      setLoading(true);
      const results = await Promise.all(
        (Object.keys(BACKENDS) as BackendMode[]).map(async (mode) => {
          try {
            return [mode, { snapshot: await fetchBackend(mode), error: null }] as const;
          } catch (error) {
            return [
              mode,
              {
                snapshot: null,
                error: error instanceof Error ? error.message : "No se pudo conectar",
              },
            ] as const;
          }
        }),
      );
      if (!cancelled) {
        setComparison(Object.fromEntries(results) as ComparisonState);
        setLoading(false);
      }
    };

    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [refreshKey]);

  const timescaleMs = comparison.timescale.snapshot?.performance.averageMs;
  const postgresMs = comparison.plain.snapshot?.performance.averageMs;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b bg-background/90">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-4 px-5 py-5">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-wider text-primary">
              PULSO · Comparativa de bases de datos
            </p>
            <h1 className="mt-1 font-display text-2xl">Rendimiento y lecturas</h1>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-right font-mono text-[10px] text-muted-foreground sm:block">
              Actualización automática · 30 s
            </span>
            <button
              type="button"
              onClick={() => setRefreshKey((key) => key + 1)}
              aria-label="Actualizar datos"
              title="Actualizar datos"
              className="inline-flex size-9 items-center justify-center rounded-md border text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              <RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1500px] px-5 py-5">
        <p className="mb-5 border-l-2 border-warn px-3 py-2 font-mono text-[11px] text-muted-foreground">
          Las lecturas almacenadas son sintéticas de prueba. Recuentos, medias y tiempos se
          consultan directamente en cada base de datos.
        </p>
        <ComparisonCharts comparison={comparison} />
        <section className="grid gap-5 xl:grid-cols-2" aria-label="Comparación de motores">
          <BackendPanel
            mode="timescale"
            state={comparison.timescale}
            loading={loading}
            otherAverageMs={postgresMs}
          />
          <BackendPanel
            mode="plain"
            state={comparison.plain}
            loading={loading}
            otherAverageMs={timescaleMs}
          />
        </section>
      </div>
    </main>
  );
}

function ComparisonCharts({ comparison }: { comparison: ComparisonState }) {
  const queryMap = new Map<
    string,
    { label: string; timescale: number | null; plain: number | null }
  >();
  for (const mode of Object.keys(BACKENDS) as BackendMode[]) {
    for (const query of comparison[mode].snapshot?.performance.queries ?? []) {
      const row = queryMap.get(query.name) ?? {
        label: shortQueryLabel(query.title),
        timescale: null,
        plain: null,
      };
      row[mode] = query.ms;
      queryMap.set(query.name, row);
    }
  }
  const queryData = Array.from(queryMap.values());

  const districtMap = new Map<
    string,
    { district: string; timescale: number | null; plain: number | null }
  >();
  for (const mode of Object.keys(BACKENDS) as BackendMode[]) {
    for (const row of comparison[mode].snapshot?.overview ?? []) {
      const district = districtMap.get(row.district) ?? {
        district: row.district,
        timescale: null,
        plain: null,
      };
      district[mode] = row.avg_temperature;
      districtMap.set(row.district, district);
    }
  }
  const districtData = Array.from(districtMap.values());

  return (
    <section className="mb-5 grid gap-5 xl:grid-cols-2" aria-label="Gráficas comparativas">
      <ComparisonChart title="Latencia por consulta" unit="ms">
        {queryData.length ? (
          <>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={queryData} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.6} />
                <XAxis
                  dataKey="label"
                  tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  formatter={(value, name) => [`${Number(value).toLocaleString("es-ES")} ms`, name]}
                  contentStyle={{
                    background: "var(--card)",
                    borderColor: "var(--border)",
                    fontSize: 11,
                  }}
                />
                <Bar
                  dataKey="timescale"
                  name="TimescaleDB"
                  fill={BACKENDS.timescale.accent}
                  radius={[3, 3, 0, 0]}
                />
                <Bar
                  dataKey="plain"
                  name="PostgreSQL"
                  fill={BACKENDS.plain.accent}
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
            <ChartValues
              rows={queryData.map((row) => ({
                label: row.label,
                timescale: row.timescale,
                plain: row.plain,
                unit: " ms",
              }))}
            />
          </>
        ) : (
          <ChartEmpty />
        )}
      </ComparisonChart>

      <ComparisonChart title="Temperatura media por barrio" unit="°C">
        {districtData.length ? (
          <>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={districtData} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid vertical={false} stroke="var(--border)" strokeOpacity={0.6} />
                <XAxis
                  dataKey="district"
                  tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "var(--muted-foreground)", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  formatter={(value, name) => [
                    `${Number(value).toLocaleString("es-ES", { maximumFractionDigits: 1 })} °C`,
                    name,
                  ]}
                  contentStyle={{
                    background: "var(--card)",
                    borderColor: "var(--border)",
                    fontSize: 11,
                  }}
                />
                <Bar
                  dataKey="timescale"
                  name="TimescaleDB"
                  fill={BACKENDS.timescale.accent}
                  radius={[3, 3, 0, 0]}
                />
                <Bar
                  dataKey="plain"
                  name="PostgreSQL"
                  fill={BACKENDS.plain.accent}
                  radius={[3, 3, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
            <ChartValues
              rows={districtData.map((row) => ({
                label: row.district,
                timescale: row.timescale,
                plain: row.plain,
                unit: " °C",
              }))}
            />
          </>
        ) : (
          <ChartEmpty />
        )}
      </ComparisonChart>
    </section>
  );
}

function ComparisonChart({
  title,
  unit,
  children,
}: {
  title: string;
  unit: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 border-y bg-card/30 px-5 py-4" aria-label={title}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="font-display text-base">{title}</h2>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] text-muted-foreground">
          <span>{unit}</span>
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-sm" style={{ background: BACKENDS.timescale.accent }} />
            TimescaleDB
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-sm" style={{ background: BACKENDS.plain.accent }} />
            PostgreSQL
          </span>
        </div>
      </div>
      <div className="h-52 min-w-0">{children}</div>
    </section>
  );
}

function ChartValues({
  rows,
}: {
  rows: Array<{ label: string; timescale: number | null; plain: number | null; unit: string }>;
}) {
  return (
    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 border-t pt-2 sm:grid-cols-3">
      {rows.map((row) => (
        <div
          key={row.label}
          className="min-w-0 font-mono text-[9px] leading-4 text-muted-foreground"
        >
          <span className="mr-1 truncate">{row.label}</span>
          <span style={{ color: BACKENDS.timescale.accent }}>
            {formatChartValue(row.timescale, row.unit)}
          </span>
          <span className="px-1">/</span>
          <span style={{ color: BACKENDS.plain.accent }}>
            {formatChartValue(row.plain, row.unit)}
          </span>
        </div>
      ))}
    </div>
  );
}

function ChartEmpty() {
  return (
    <p className="flex h-full items-center justify-center font-mono text-xs text-muted-foreground">
      Esperando datos de ambas bases…
    </p>
  );
}

function shortQueryLabel(title: string) {
  if (title.toLowerCase().includes("barrio")) return "Media barrio";
  if (title.toLowerCase().includes("picos")) return "Picos CPU/red";
  return "Serie temporal";
}

function formatChartValue(value: number | null, unit: string) {
  return value === null
    ? "—"
    : `${value.toLocaleString("es-ES", { maximumFractionDigits: 1 })}${unit}`;
}

function BackendPanel({
  mode,
  state,
  loading,
  otherAverageMs,
}: {
  mode: BackendMode;
  state: BackendState;
  loading: boolean;
  otherAverageMs?: number;
}) {
  const backend = BACKENDS[mode];
  const snapshot = state.snapshot;
  const totalSamples = snapshot?.overview.reduce((sum, row) => sum + row.samples, 0) ?? 0;
  const averageTemperature = weightedAverage(snapshot?.overview ?? [], "avg_temperature");
  const averageHumidity = weightedAverage(snapshot?.overview ?? [], "avg_humidity");
  const averageMs = snapshot?.performance.averageMs;
  const speedRatio = averageMs && otherAverageMs ? otherAverageMs / averageMs : null;
  const faster = speedRatio !== null && speedRatio >= 1;

  return (
    <section
      className="min-w-0 overflow-hidden rounded-md border bg-card/40"
      style={{ borderTopColor: backend.accent, borderTopWidth: 3 }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="font-display text-xl">{backend.label}</h2>
          <p className="mt-1 font-mono text-[10px] text-muted-foreground">
            {mode === "timescale" ? "Hypertable · time_bucket" : "Tabla PostgreSQL estándar"}
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-2 font-mono text-[10px] ${snapshot ? "text-pos" : state.error ? "text-neg" : "text-muted-foreground"}`}
        >
          <span
            className={`size-1.5 rounded-full ${snapshot ? "bg-pos" : state.error ? "bg-neg" : "bg-dim"}`}
          />
          {snapshot ? "CONECTADO" : state.error ? "SIN CONEXIÓN" : "CONECTANDO"}
        </span>
      </div>

      {state.error ? (
        <div className="px-5 py-8 text-sm text-neg">
          {state.error}. Comprueba que la API esté activa.
        </div>
      ) : !snapshot ? (
        <div className="px-5 py-8 font-mono text-sm text-muted-foreground">
          {loading ? "Consultando la base de datos…" : "No hay datos disponibles."}
        </div>
      ) : (
        <div className="divide-y">
          <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-4">
            <SummaryMetric
              label="Latencia media"
              value={formatMs(averageMs ?? 0)}
              detail="3 consultas medidas"
            />
            <SummaryMetric
              label="Lecturas"
              value={formatNumber(totalSamples)}
              detail="últimos 15 min"
            />
            <SummaryMetric
              label="Temp. media"
              value={formatMetric(averageTemperature, " °C")}
              detail="ponderada por lecturas"
            />
            <SummaryMetric
              label="Humedad media"
              value={formatMetric(averageHumidity, "%")}
              detail="ponderada por lecturas"
            />
          </div>

          <div className="px-5 py-4">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="font-display text-base">Ejecución de consultas</h3>
              <span
                className={`font-mono text-[10px] ${speedRatio === null ? "text-muted-foreground" : faster ? "text-pos" : "text-warn"}`}
              >
                {speedRatio === null
                  ? "Comparación pendiente"
                  : `${speedRatio.toFixed(2)}× ${faster ? "más rápido" : "más lento"} que ${mode === "timescale" ? "PostgreSQL" : "TimescaleDB"}`}
              </span>
            </div>
            {snapshot.performance.queries.length ? (
              <ul className="divide-y divide-border/60">
                {snapshot.performance.queries.map((query) => (
                  <li
                    key={query.name}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[12px]"
                  >
                    <span className="min-w-0 flex-1">{query.title}</span>
                    <span className="font-mono tabular-nums" style={{ color: backend.accent }}>
                      {formatMs(query.ms)}
                    </span>
                    <span className="w-24 text-right font-mono text-[10px] text-muted-foreground">
                      {formatNumber(query.rows)} filas
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">
                La API no devolvió resultados para estas consultas.
              </p>
            )}
          </div>

          <div className="px-5 py-4">
            <div className="mb-3 flex items-baseline justify-between gap-2">
              <h3 className="font-display text-base">Promedios por barrio</h3>
              <span className="font-mono text-[10px] text-muted-foreground">
                ventana de 15 min · {formatNumber(totalSamples)} lecturas
              </span>
            </div>
            {snapshot.overview.length ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[440px] text-left text-[11px]">
                  <thead className="font-mono text-[9px] uppercase text-muted-foreground">
                    <tr>
                      <th className="pb-2 font-normal">Barrio</th>
                      <th className="pb-2 text-right font-normal">Temp. °C</th>
                      <th className="pb-2 text-right font-normal">Humedad %</th>
                      <th className="pb-2 text-right font-normal">CPU media</th>
                      <th className="pb-2 text-right font-normal">Muestras</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50 font-mono tabular-nums">
                    {snapshot.overview.map((row) => (
                      <tr key={row.district}>
                        <td className="py-2 font-sans">{row.district}</td>
                        <td className="py-2 text-right">{formatMetric(row.avg_temperature)}</td>
                        <td className="py-2 text-right">{formatMetric(row.avg_humidity)}</td>
                        <td className="py-2 text-right">{formatMetric(row.avg_cpu)}</td>
                        <td className="py-2 text-right">{formatNumber(row.samples)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">No hay lecturas en esta ventana.</p>
            )}
          </div>

          <div className="flex flex-wrap justify-between gap-2 px-5 py-3 font-mono text-[10px] text-muted-foreground">
            <span>Consultado: {snapshot.fetchedAt}</span>
            <span>{snapshot.performance.queries.length} consultas ejecutadas</span>
          </div>
        </div>
      )}
    </section>
  );
}

function SummaryMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="bg-background/70 px-4 py-3">
      <p className="font-mono text-[9px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-mono text-lg tabular-nums">{value}</p>
      <p className="mt-1 font-mono text-[9px] text-muted-foreground">{detail}</p>
    </div>
  );
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function weightedAverage(rows: OverviewRow[], key: "avg_temperature" | "avg_humidity") {
  const validRows = rows.filter((row) => row[key] !== null && row.samples > 0);
  const samples = validRows.reduce((sum, row) => sum + row.samples, 0);
  if (!samples) return null;
  return validRows.reduce((sum, row) => sum + row[key]! * row.samples, 0) / samples;
}

function formatNumber(value: number) {
  return Number.isFinite(value) ? value.toLocaleString("es-ES") : "—";
}

function formatMetric(value: number | null, suffix = "") {
  return value !== null && Number.isFinite(value)
    ? `${value.toLocaleString("es-ES", { maximumFractionDigits: 1 })}${suffix}`
    : "—";
}

function formatMs(value: number) {
  return Number.isFinite(value)
    ? `${value.toLocaleString("es-ES", { maximumFractionDigits: 2 })} ms`
    : "—";
}
