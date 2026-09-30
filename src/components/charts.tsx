interface LineSeries {
  values: number[];
  color: string; // CSS var reference, e.g. "var(--chart-1)"
  label?: string;
}

function path(values: number[], min: number, max: number, w: number, h: number) {
  const span = max - min || 1;
  return values
    .map((v, i) => `${i === 0 ? "M" : "L"}${((i / (values.length - 1)) * w).toFixed(2)},${(h - ((v - min) / span) * h).toFixed(2)}`)
    .join(" ");
}

export function LineChart({ series, height = 240, area = false, pad = 0.1 }: { series: LineSeries[]; height?: number; area?: boolean; pad?: number }) {
  const all = series.flatMap((s) => s.values);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const r = hi - lo || 1;
  const min = lo - r * pad;
  const max = hi + r * pad;
  const W = 1000;
  const H = height;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full">
      {[0.25, 0.5, 0.75].map((y) => (
        <line key={y} x1={0} x2={W} y1={H * y} y2={H * y} stroke="var(--border)" strokeOpacity={0.5} vectorEffect="non-scaling-stroke" />
      ))}
      {series.map((s, i) => {
        const d = path(s.values, min, max, W, H);
        return (
          <g key={i}>
            {area && <path d={`${d} L${W},${H} L0,${H} Z`} fill={s.color} fillOpacity={0.12} />}
            <path d={d} fill="none" stroke={s.color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </g>
        );
      })}
    </svg>
  );
}

export function Sparkline({ values, color = "var(--primary)" }: { values: number[]; color?: string }) {
  return <LineChart series={[{ values, color }]} height={60} area pad={0.15} />;
}

export function Bars({ values, color = "var(--primary)" }: { values: number[]; color?: string }) {
  const max = Math.max(...values);
  const min = Math.min(...values) * 0.9;
  return (
    <div className="flex h-full items-end gap-[3px]">
      {values.map((v, i) => {
        const pct = ((v - min) / (max - min || 1)) * 85 + 15;
        return (
          <div
            key={i}
            className="flex-1 rounded-t-[2px] transition-[height] duration-500"
            style={{ height: `${pct}%`, background: color, opacity: i === values.length - 1 ? 1 : 0.35 + (pct / 100) * 0.45 }}
          />
        );
      })}
    </div>
  );
}
