import { useEffect, useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { full, moveIndex, nearestIndex, shortDay, type ChartSeries } from './data';
import { PALETTE_CSS } from './palette';
import { useElementSize } from './useElementWidth';

/*
 * The Stats page's chart as the redesign's board draws it: one line over a fading yellow area when it
 * is the total, a line per series in its channel's colour otherwise; two hairlines for scale, the
 * axis, three days under it and the launch that went out marked on the line. No value axis: the KPI
 * above says the number, the chart says the shape. A pointer or the arrow keys read any point out,
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
  /** A launch to mark on the line: the bucket it went out in and its words */
  mark?: { index: number; label: string } | null;
  className?: string;
}

/** Room under the axis for the days, and where the tallest value reaches (as on the board) */
const AXIS_GAP = 18;
const PEAK = 0.36;
/**
 * The boards draw the chart in a fixed frame (358 wide on a phone, 720 on a desktop) scaled down to
 * the card: narrower than that, the drawing shrinks and centres vertically. Its rows follow the same
 * scale here, so the axis and the days sit where the board puts them.
 */
const frameWidth = (height: number) => (height < 200 ? 358 : 720);

export function TrendChart({ title, buckets, unit, series, noun, mark, className }: TrendChartProps) {
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
  const x = (i: number) => (n <= 1 ? width / 2 : (i / (n - 1)) * width);
  const y = (v: number) => (max === 0 ? base : base - (v / max) * (base - row(height * PEAK)));
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
  const markText = mark && mark.index >= 0 && mark.index < n ? mark : null;
  const markX = markText ? x(markText.index) : 0;
  // Inter Tight at 12 px is about 6.2 px a character: the label goes to the side with more room, cut to fit it
  const room = { right: width - markX - 10, left: markX - 10 };
  const markFlip = markText ? markText.label.length * (6.2 * scale) > room.right && room.left > room.right : false;
  const fits = Math.max(4, Math.floor((markFlip ? room.left : room.right) / (6.2 * scale)));
  const markLabel = markText ? (markText.label.length > fits ? `${markText.label.slice(0, fits - 1).trimEnd()}…` : markText.label) : '';

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
              <line x1={0} y1={row(height / 4)} x2={width} y2={row(height / 4)} />
              <line x1={0} y1={row(height / 2)} x2={width} y2={row(height / 2)} />
            </g>
            {single && series[0] && (
              <>
                <path d={`M0 ${base} L${points(series[0]).replace(/ /g, ' L')} L${width} ${base} Z`} fill={`url(#${gradient})`} />
                <polyline points={points(series[0])} fill="none" stroke="var(--sc-yellow)" strokeWidth={3} strokeLinejoin="round" />
              </>
            )}
            {!single && series.map((s) => <polyline key={s.key} points={points(s)} fill="none" stroke={s.colour} strokeWidth={2.5} strokeLinejoin="round" />)}
            <line className="stats-chart-axis" x1={0} y1={base} x2={width} y2={base} />
            {markText && (
              <g className="stats-chart-mark" style={{ fontSize: 12 * scale }}>
                <circle cx={markX} cy={y(single ? (series[0]?.values[markText.index] ?? 0) : Math.max(...series.map((s) => s.values[markText.index] ?? 0)))} r={5} />
                <text x={markFlip ? markX - 10 : markX + 10} y={y(single ? (series[0]?.values[markText.index] ?? 0) : Math.max(...series.map((s) => s.values[markText.index] ?? 0))) + 4} textAnchor={markFlip ? 'end' : 'start'}>
                  {markLabel}
                </text>
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
