import { useEffect, useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { compact, full, moveIndex, nearestIndex, niceTop, placeMarks, shortDay, type ChartSeries } from './data';
import { PALETTE_CSS } from './palette';
import { useElementSize } from './useElementWidth';

/*
 * The Stats page's chart as the redesign's board draws it: one line over a fading yellow area when it
 * is the total, a line per series in its channel's colour otherwise; the axis and three days under it.
 * The values fill the plot (the top a round number a little over the highest value), with two
 * hairlines at the top and the half of that scale, each with its number. The launches that went out
 * are dots on the line with a thin guide up to their names in a row above the plot, where a name never
 * crosses the line, the axis or another name (placeMarks). A pointer or the arrow keys read any point out,
 * and a hidden table holds every value for screen readers. Height comes from the stylesheet (170 px
 * on a phone, 280 from 960 px), so the same chart fits both boards.
 */

export interface TrendChartProps {
  /** Its accessible name: "Views per day" */
  title: string;
  buckets: readonly string[];
  unit: 'day' | 'week';
  series: readonly ChartSeries[];
  /** What a value is, for the readout: "views" */
  noun: string;
  /** Launches to mark on the line: the bucket each went out in and its words */
  marks?: ReadonlyArray<{ index: number; label: string }>;
  className?: string;
}

/** Room under the axis for the days, and the row above the plot for the marks' names */
const AXIS_GAP = 18;
const MARK_ROW = 20;
/**
 * The boards draw the chart in a fixed frame (358 wide on a phone, 720 on a desktop) scaled down to
 * the card: narrower than that, the drawing shrinks and centres vertically. Its rows follow the same
 * scale here, so the axis and the days sit where the board puts them.
 */
const frameWidth = (height: number) => (height < 200 ? 358 : 720);

export function TrendChart({ title, buckets, unit, series, noun, marks = [], className }: TrendChartProps) {
  const [box, { width, height }] = useElementSize<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const gradient = useId().replace(/:/g, '');
  const n = buckets.length;
  const signature = `${buckets[0] ?? ''}:${n}:${series.map((s) => s.key).join(',')}`;
  useEffect(() => setActive(null), [signature]);

  const single = series.length === 1;
  const scale = Math.min(1, width / frameWidth(height));
  const top = (height - height * scale) / 2;
  const row = (v: number) => top + v * scale;
  const base = row(height - AXIS_GAP);
  const max = Math.max(0, ...series.flatMap((s) => s.values.map((v) => v ?? 0)));
  const domain = niceTop(max);
  const x = (i: number) => (n <= 1 ? width / 2 : (i / (n - 1)) * width);
  const shown = marks.filter((m) => m.index >= 0 && m.index < n);
  const plotTop = row(shown.length > 0 ? MARK_ROW + 6 : 8);
  const y = (v: number) => base - (v / domain) * (base - plotTop);
  const points = (s: ChartSeries) => s.values.map((v, i) => `${x(i).toFixed(1)},${y(v ?? 0).toFixed(1)}`).join(' ');
  const totalAt = (i: number) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0);
  const middle = Math.floor((n - 1) / 2);
  const ticks = n > 2 ? [0, middle, n - 1] : n === 2 ? [0, 1] : [0];

  const onPointer = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setActive(nearestIndex(event.clientX - rect.left, 0, n > 1 ? width / (n - 1) : width, n));
  };
  const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === 'Escape') return setActive(null);
    const next = moveIndex(event.key, active, n);
    if (next === null) return;
    event.preventDefault();
    setActive(next);
  };

  const when = (i: number) => (unit === 'week' ? `Week of ${shortDay(buckets[i] ?? '')}` : shortDay(buckets[i] ?? ''));
  const readout =
    active === null
      ? ''
      : single
        ? `${when(active)}: ${full(series[0]?.values[active] ?? 0)} ${noun}`
        : `${when(active)}: ${series.map((s) => `${s.label} ${full(s.values[active] ?? 0)}`).join(', ')}`;
  // Inter Tight at 12 px is about 6.2 px a character, scaled with the frame
  // The row's right end keeps room for the scale's top number
  const placed = placeMarks(shown.map((m) => ({ index: m.index, x: x(m.index), label: m.label })), width - 28 * scale, 6.2 * scale);
  const highestAt = (i: number) => Math.max(...series.map((s) => s.values[i] ?? 0));

  return (
    <div className={`stats-chart${className ? ` ${className}` : ''}`}>
      <style href="shipcast-chart-palette" precedence="default">
        {PALETTE_CSS}
      </style>
      <div ref={box} className="stats-chart-plot">
        {width > 0 && height > 0 && (
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={`${title}, ${shortDay(buckets[0] ?? '')} to ${shortDay(buckets[n - 1] ?? '')}. Arrow keys read each ${unit}.`}
            tabIndex={0}
            onPointerMove={onPointer}
            onPointerDown={onPointer}
            onPointerLeave={() => setActive(null)}
            onKeyDown={onKeyDown}
            onBlur={() => setActive(null)}
          >
            <defs>
              <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="var(--sc-yellow)" stopOpacity=".35" />
                <stop offset="1" stopColor="var(--sc-yellow)" stopOpacity="0" />
              </linearGradient>
            </defs>
            <g className="stats-chart-grid">
              <line x1={0} y1={plotTop} x2={width} y2={plotTop} />
              <line x1={0} y1={y(domain / 2)} x2={width} y2={y(domain / 2)} />
            </g>
            <g className="stats-chart-values" style={{ fontSize: 10 * scale }} aria-hidden="true">
              <text x={width} y={plotTop - 3} textAnchor="end">
                {compact(domain)}
              </text>
              <text x={width} y={y(domain / 2) - 3} textAnchor="end">
                {compact(domain / 2)}
              </text>
            </g>
            {single && series[0] && (
              <>
                <path d={`M0 ${base} L${points(series[0]).replace(/ /g, ' L')} L${width} ${base} Z`} fill={`url(#${gradient})`} />
                <polyline points={points(series[0])} fill="none" stroke="var(--sc-yellow)" strokeWidth={3} strokeLinejoin="round" />
              </>
            )}
            {!single && series.map((s) => <polyline key={s.key} points={points(s)} fill="none" stroke={s.colour} strokeWidth={2.5} strokeLinejoin="round" />)}
            <line className="stats-chart-axis" x1={0} y1={base} x2={width} y2={base} />
            {placed.length > 0 && (
              <g className="stats-chart-mark" style={{ fontSize: 12 * scale }}>
                {shown.map((m) => (
                  <g key={`${m.index}-${m.label}`}>
                    <line x1={x(m.index)} y1={row(MARK_ROW) + 3} x2={x(m.index)} y2={y(highestAt(m.index)) - 5} />
                    <circle cx={x(m.index)} cy={y(highestAt(m.index))} r={5} />
                  </g>
                ))}
                {placed.map((p) => (
                  <text key={`t-${p.index}-${p.text}`} x={p.anchor === 'start' ? p.x - 1 : p.x + 1} y={row(MARK_ROW) - 2} textAnchor={p.anchor}>
                    {p.text}
                  </text>
                ))}
              </g>
            )}
            {active !== null && (
              <g className="stats-chart-active" aria-hidden="true">
                <line x1={x(active)} y1={0} x2={x(active)} y2={base} />
                {series.map((s) => (
                  <circle key={s.key} cx={x(active)} cy={y(s.values[active] ?? 0)} r={4} fill={single ? 'var(--sc-yellow)' : s.colour} />
                ))}
              </g>
            )}
            <g className="stats-chart-days" style={{ fontSize: 11 * scale }}>
              {ticks.map((i, k) => (
                <text key={i} x={x(i)} y={row(height - 2)} textAnchor={k === ticks.length - 1 && k > 0 ? 'end' : 'start'}>
                  {shortDay(buckets[i] ?? '')}
                </text>
              ))}
            </g>
          </svg>
        )}
        {active !== null && (
          <div className="stats-chart-tip" style={{ left: Math.min(Math.max(x(active), 70), Math.max(70, width - 70)) }} aria-hidden="true">
            <span className="k-muted">{when(active)}</span> <strong>{single ? full(series[0]?.values[active] ?? 0) : full(totalAt(active))}</strong>
          </div>
        )}
      </div>
      <p className="visually-hidden" aria-live="polite">
        {readout}
      </p>
      {!single && series.length > 0 && (
        <ul className="stats-chart-legend" aria-label="Series">
          {series.map((s) => (
            <li key={s.key}>
              <span className="stats-chart-swatch" style={{ background: s.colour }} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
      )}
      <table className="visually-hidden">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{unit === 'week' ? 'Week' : 'Day'}</th>
            {series.map((s) => (
              <th key={s.key} scope="col">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {buckets.map((b, i) => (
            <tr key={b}>
              <th scope="row">{when(i)}</th>
              {series.map((s) => (
                <td key={s.key}>{full(s.values[i] ?? 0)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
