import { AxisBottom, AxisLeft } from '@visx/axis';
import { curveMonotoneX } from '@visx/curve';
import { GridRows } from '@visx/grid';
import { Group } from '@visx/group';
import { scaleBand, scaleLinear, scalePoint } from '@visx/scale';
import { Area, LinePath } from '@visx/shape';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import {
  brushRange,
  bucketLabel,
  compact,
  comparisonTotals,
  dayLabel,
  full,
  levelDomain,
  moveIndex,
  nearestIndex,
  sliceRange,
  stack,
  tickEvery,
  totals,
  valueCeiling,
  type ChartKind,
  type ChartSeries,
} from './data';
import { PALETTE_CSS } from './palette';
import { useElementWidth } from './useElementWidth';

/*
 * The time chart every stats view draws: lines, stacked areas or stacked bars over evenly spaced
 * buckets, the comparison period dashed, a crosshair with a tooltip, zoom by brushing, and the same
 * thing for the keyboard (arrows move through the points, Shift with an arrow marks a range, Enter
 * zooms to it) and for screen readers (a live summary of the point and a hidden table of every
 * value). Drawn with visx primitives so every mark wears Cartel's tokens. Nothing animates.
 * See docs/decisions/charts.md
 */

export interface TimeChartProps {
  /** What the chart shows, its accessible name: "Views per day, by channel" */
  title: string;
  buckets: readonly string[];
  unit: 'day' | 'week';
  series: readonly ChartSeries[];
  kind: ChartKind;
  /** Levels (followers) rather than increases: the axis hugs the values instead of starting at zero */
  levels?: boolean;
  height?: number;
  /** What the dashed line is, in the legend and the tooltip */
  comparisonName?: string;
  /** Brushing to zoom; off for small charts */
  zoomable?: boolean;
  /** Something to put beside the legend, at its right: the reset button sits there too */
  tools?: ReactNode;
}

const MARGIN = { top: 14, right: 14, bottom: 30, left: 48 };
const MARGIN_NARROW = { top: 12, right: 8, bottom: 30, left: 38 };

export function TimeChart({ title, buckets, unit, series, kind, levels = false, height = 300, comparisonName = 'Previous period', zoomable = true, tools }: TimeChartProps) {
  const [box, width] = useElementWidth<HTMLDivElement>();
  const hintId = useId();
  const tableId = useId();
  const [zoom, setZoom] = useState<[number, number] | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  // The values as a visible table: for whoever reads numbers better than lines, or cannot tell the colours apart
  const [asTable, setAsTable] = useState(false);
  const plotRef = useRef<HTMLDivElement>(null);

  // New data (another period, metric or filter) is another chart: the zoom and the point reset
  const signature = `${buckets[0] ?? ''}:${buckets.length}:${series.map((s) => s.key).join(',')}:${kind}`;
  useEffect(() => {
    setZoom(null);
    setActive(null);
    setAnchor(null);
  }, [signature]);

  const shownBuckets = useMemo(() => (zoom ? buckets.slice(zoom[0], zoom[1] + 1) : [...buckets]), [buckets, zoom]);
  const shown = useMemo(() => sliceRange(series, zoom), [series, zoom]);
  const n = shownBuckets.length;
  const hasComparison = shown.some((s) => s.comparison);
  const stacked = kind !== 'line';

  const margin = width < 480 ? MARGIN_NARROW : MARGIN;
  const innerW = Math.max(0, width - margin.left - margin.right);
  const innerH = Math.max(0, height - margin.top - margin.bottom);

  const xBand = useMemo(() => scaleBand<string>({ domain: shownBuckets, range: [0, innerW], paddingInner: n > 60 ? 0.12 : 0.24, paddingOuter: 0.08 }), [shownBuckets, innerW, n]);
  const xPoint = useMemo(() => scalePoint<string>({ domain: shownBuckets, range: [0, innerW], padding: n === 1 ? 0.5 : 0 }), [shownBuckets, innerW, n]);
  const xAt = (i: number) => {
    const b = shownBuckets[i] ?? '';
    return kind === 'bar' ? (xBand(b) ?? 0) + xBand.bandwidth() / 2 : (xPoint(b) ?? 0);
  };
  const step = n > 1 ? xAt(1) - xAt(0) : innerW;
  const domain = levels ? levelDomain(shown) : ([0, valueCeiling(shown, kind, n)] as [number, number]);
  const y = useMemo(() => scaleLinear<number>({ domain, range: [innerH, 0], nice: levels }), [domain[0], domain[1], innerH, levels]);

  const stacks = useMemo(() => (stacked ? stack(shown, n) : []), [shown, n, stacked]);
  const prevTotals = useMemo(() => (stacked && hasComparison ? comparisonTotals(shown, n) : []), [shown, n, stacked, hasComparison]);
  const sums = useMemo(() => totals(shown, n), [shown, n]);

  const every = tickEvery(n, innerW, width < 480 ? 56 : 72);
  const xTicks = shownBuckets.filter((_, i) => i % every === 0);
  const spansYears = (shownBuckets[0] ?? '').slice(0, 4) !== (shownBuckets[n - 1] ?? '').slice(0, 4);
  const yTicks = width < 480 ? 3 : 5;

  const indexAt = (event: PointerEvent<Element>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return nearestIndex(event.clientX - rect.left - margin.left, xAt(0), step, n);
  };

  const onPointerMove = (event: PointerEvent<SVGRectElement>) => {
    const i = indexAt(event);
    setActive(i);
    if (drag) setDrag({ from: drag.from, to: i });
  };
  const onPointerDown = (event: PointerEvent<SVGRectElement>) => {
    if (!zoomable || event.button !== 0) return;
    // Without this the drag is also the browser's text selection, painted across the whole page
    // width, and a selection in progress can swallow the pointer up that ends the brush
    event.preventDefault();
    plotRef.current?.focus({ preventScroll: true });
    const i = indexAt(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({ from: i, to: i });
  };
  const onPointerUp = (event: PointerEvent<SVGRectElement>) => {
    if (!drag) return;
    // The release point counts even when no move was reported on the way there
    const range = brushRange(drag.from, indexAt(event), n);
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (range) zoomTo(range);
  };

  const zoomTo = ([lo, hi]: [number, number]) => {
    const offset = zoom ? zoom[0] : 0;
    setZoom([offset + lo, offset + hi]);
    setActive(null);
    setAnchor(null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      if (anchor !== null) setAnchor(null);
      else setActive(null);
      return;
    }
    if (event.key === 'Enter' && zoomable && anchor !== null && active !== null) {
      const range = brushRange(anchor, active, n);
      if (range) {
        event.preventDefault();
        zoomTo(range);
      }
      return;
    }
    const next = moveIndex(event.key, active, n);
    if (next === null) return;
    event.preventDefault();
    if (event.shiftKey && zoomable) setAnchor((a) => a ?? active ?? next);
    else setAnchor(null);
    setActive(next);
  };

  const selection = drag ? brushRange(drag.from, drag.to, n) : anchor !== null && active !== null ? brushRange(anchor, active, n) : null;
  // The band covers whole buckets but never leaves the plot: half a step past the first or last
  // bucket would otherwise spill over the axis and out of the chart
  const band = selection ? brushBand(xAt(selection[0]), xAt(selection[1]), step, innerW) : null;
  // useId's characters are not all valid in url(#…); the server has no CSS.escape
  const clipId = `chart-clip-${hintId.replace(/[^\w-]/g, '')}`;
  const activeBucket = active !== null ? shownBuckets[active] : undefined;
  const summary = activeBucket !== undefined && active !== null ? pointSummary(bucketLabel(activeBucket, unit), shown, active, hasComparison, comparisonName) : '';
  const tooltipLeft = active !== null ? margin.left + xAt(active) : 0;
  const flip = tooltipLeft > width / 2;

  return (
    <figure className="chart">
      {/* One copy for every chart on the page: React hoists a style with an href and keeps one */}
      <style href="shipcast-chart-palette" precedence="default">
        {PALETTE_CSS}
      </style>
      <figcaption className="visually-hidden">{title}</figcaption>
      <div className="chart-head">
        <Legend series={shown} kind={kind} comparison={hasComparison ? (stacked ? 'total' : 'series') : null} comparisonName={comparisonName} />
        <div className="chart-tools">
          {tools}
          <button type="button" className="btn btn-small" aria-expanded={asTable} aria-controls={tableId} onClick={() => setAsTable((v) => !v)}>
            {asTable ? 'Hide the data' : 'Show the data'}
          </button>
          {zoom && (
            <button type="button" className="btn btn-small" onClick={() => setZoom(null)}>
              Reset zoom
            </button>
          )}
        </div>
      </div>
      <div ref={box} className="chart-box" style={{ height }}>
        {width > 0 && n > 0 && (
          <div
            ref={plotRef}
            className="chart-plot"
            tabIndex={0}
            role="group"
            aria-roledescription="chart"
            aria-label={`${title}${zoom ? `, zoomed to ${dayLabel(shownBuckets[0] ?? '')} – ${dayLabel(shownBuckets[n - 1] ?? '')}` : ''}`}
            aria-describedby={hintId}
            onKeyDown={onKeyDown}
            onBlur={() => {
              setAnchor(null);
              setActive(null);
            }}
          >
            <svg width={width} height={height} aria-hidden="true" className="chart-svg">
              <defs>
                <clipPath id={clipId}>
                  <rect x={0} y={0} width={innerW} height={innerH} />
                </clipPath>
              </defs>
              <Group left={margin.left} top={margin.top}>
                <GridRows scale={y} width={innerW} numTicks={yTicks} stroke="var(--sc-hairline)" strokeWidth={1} />
                {band && <rect className="chart-brush" x={band.x} width={band.width} y={0} height={innerH} clipPath={`url(#${clipId})`} />}
                {kind === 'line' &&
                  shown.map((s) => (
                    <g key={s.key}>
                      {s.comparison && (
                        <LinePath<number | null>
                          data={s.comparison}
                          x={(_, i) => xAt(i)}
                          y={(v) => y(v ?? 0)}
                          defined={(v) => v !== null}
                          curve={curveMonotoneX}
                          stroke={s.colour}
                          strokeWidth={1.5}
                          strokeDasharray="5 5"
                          fill="none"
                        />
                      )}
                      <LinePath<number | null> data={s.values} x={(_, i) => xAt(i)} y={(v) => y(v ?? 0)} defined={(v) => v !== null} curve={curveMonotoneX} stroke={s.colour} strokeWidth={2} strokeLinejoin="round" fill="none" />
                      {/* A lone point (a single bucket, or one between gaps) still shows as a dot */}
                      {s.values.map((v, i) => (v !== null && (s.values[i - 1] ?? null) === null && (s.values[i + 1] ?? null) === null ? <circle key={i} cx={xAt(i)} cy={y(v)} r={3} fill={s.colour} /> : null))}
                    </g>
                  ))}
                {kind === 'area' &&
                  stacks.map((band, si) => (
                    <Area<number>
                      key={band.key}
                      data={band.y1}
                      x={(_, i) => xAt(i)}
                      y0={(_, i) => y(band.y0[i] ?? 0)}
                      y1={(v) => y(v)}
                      curve={curveMonotoneX}
                      fill={shown[si]?.colour}
                      stroke="var(--sc-raised)"
                      strokeWidth={1.5}
                    />
                  ))}
                {kind === 'bar' &&
                  stacks.map((band, si) =>
                    band.y1.map((top, i) => {
                      const base = band.y0[i] ?? 0;
                      if (top - base <= 0) return null;
                      const h = Math.max(1, y(base) - y(top) - (base > 0 ? 2 : 0));
                      return <rect key={`${band.key}-${i}`} x={(xBand(shownBuckets[i] ?? '') ?? 0)} width={Math.max(1, xBand.bandwidth())} y={y(top)} height={h} fill={shown[si]?.colour} rx={Math.min(3, xBand.bandwidth() / 3)} />;
                    }),
                  )}
                {stacked && hasComparison && (
                  <LinePath<number | null> data={prevTotals} x={(_, i) => xAt(i)} y={(v) => y(v ?? 0)} defined={(v) => v !== null} curve={curveMonotoneX} stroke="var(--sc-text)" strokeWidth={1.5} strokeDasharray="5 5" fill="none" />
                )}
                <AxisLeft
                  scale={y}
                  numTicks={yTicks}
                  hideAxisLine
                  hideTicks
                  tickFormat={(v) => compact(Number(v))}
                  tickLabelProps={() => ({ fill: 'var(--sc-muted)', fontSize: 12, fontFamily: 'var(--sc-font-text)', textAnchor: 'end', dx: -6, dy: '0.33em' })}
                />
                <AxisBottom
                  top={innerH}
                  scale={kind === 'bar' ? xBand : xPoint}
                  tickValues={xTicks}
                  stroke="var(--sc-rail)"
                  tickStroke="var(--sc-rail)"
                  tickLength={4}
                  tickFormat={(b) => dayLabel(String(b), spansYears && unit === 'week')}
                  tickLabelProps={(_, i) => ({ fill: 'var(--sc-muted)', fontSize: 12, fontFamily: 'var(--sc-font-text)', textAnchor: i === 0 && kind !== 'bar' ? 'start' : i === xTicks.length - 1 && kind !== 'bar' && (xPoint(xTicks[i] ?? '') ?? 0) > innerW - 24 ? 'end' : 'middle' })}
                />
                {active !== null && (
                  <g className="chart-crosshair">
                    <line x1={xAt(active)} x2={xAt(active)} y1={0} y2={innerH} stroke="var(--sc-text)" strokeWidth={1} strokeDasharray="2 3" />
                    {kind === 'line'
                      ? shown.map((s) => {
                          const v = s.values[active];
                          return v === null || v === undefined ? null : <circle key={s.key} cx={xAt(active)} cy={y(v)} r={4.5} fill={s.colour} stroke="var(--sc-raised)" strokeWidth={2} />;
                        })
                      : <circle cx={xAt(active)} cy={y(sums[active] ?? 0)} r={4.5} fill="var(--sc-text)" stroke="var(--sc-raised)" strokeWidth={2} />}
                  </g>
                )}
                <rect
                  className={zoomable ? 'chart-hit zoomable' : 'chart-hit'}
                  x={-margin.left}
                  y={0}
                  width={width}
                  height={innerH}
                  fill="transparent"
                  onPointerMove={onPointerMove}
                  onPointerDown={onPointerDown}
                  onPointerUp={onPointerUp}
                  onPointerCancel={() => setDrag(null)}
                  onPointerLeave={() => {
                    if (!drag && document.activeElement !== plotRef.current) setActive(null);
                  }}
                />
              </Group>
            </svg>
            {active !== null && activeBucket !== undefined && (
              <div className="chart-tooltip" aria-hidden="true" style={flip ? { right: Math.max(4, width - tooltipLeft + 12) } : { left: Math.min(tooltipLeft + 12, Math.max(4, width - 244)) }}>
                <p className="chart-tooltip-title">{bucketLabel(activeBucket, unit)}</p>
                <ul>
                  {shown.map((s) => (
                    <li key={s.key}>
                      <Swatch colour={s.colour} kind={kind} />
                      <span className="chart-tooltip-label">{s.label}</span>
                      <span className="chart-tooltip-value">{s.values[active] === null ? '—' : full(s.values[active] ?? 0)}</span>
                      {s.comparison && <span className="chart-tooltip-prev">{s.comparison[active] === null || s.comparison[active] === undefined ? '' : `was ${full(s.comparison[active] ?? 0)}`}</span>}
                    </li>
                  ))}
                  {stacked && shown.length > 1 && (
                    <li className="chart-tooltip-total">
                      <span aria-hidden="true" className="chart-swatch" />
                      <span className="chart-tooltip-label">Total</span>
                      <span className="chart-tooltip-value">{full(sums[active] ?? 0)}</span>
                      {hasComparison && <span className="chart-tooltip-prev">{prevTotals[active] === null || prevTotals[active] === undefined ? '' : `was ${full(prevTotals[active] ?? 0)}`}</span>}
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
      <p id={hintId} className="visually-hidden">
        Use the left and right arrow keys to move through the {unit === 'week' ? 'weeks' : 'days'}, Home and End to jump to the ends.
        {zoomable ? ' Hold Shift with an arrow to mark a range and press Enter to zoom to it.' : ''} The values are also in the table that follows.
      </p>
      <p className="visually-hidden" aria-live="polite">
        {summary}
      </p>
      <DataTable id={tableId} visible={asTable} title={title} buckets={shownBuckets} unit={unit} series={shown} comparisonName={comparisonName} />
    </figure>
  );
}

/** A brushed range's band in plot coordinates, held inside [0, plotWidth] */
function brushBand(a: number, b: number, step: number, plotWidth: number): { x: number; width: number } {
  const x0 = Math.max(0, Math.min(a, b) - step / 2);
  const x1 = Math.min(plotWidth, Math.max(a, b) + step / 2);
  return { x: x0, width: Math.max(0, x1 - x0) };
}

/** The point in one sentence, for the live region: what a sighted reader gets from the tooltip */
function pointSummary(label: string, series: readonly ChartSeries[], i: number, comparison: boolean, comparisonName: string): string {
  const parts = series.map((s) => {
    const v = s.values[i];
    const prev = comparison ? s.comparison?.[i] : undefined;
    return `${s.label} ${v === null || v === undefined ? 'not read' : full(v)}${prev !== undefined && prev !== null ? ` (${comparisonName.toLowerCase()} ${full(prev)})` : ''}`;
  });
  return `${label}: ${parts.join(', ')}`;
}

function Swatch({ colour, kind, dashed }: { colour: string; kind: ChartKind; dashed?: boolean }) {
  if (kind === 'line' || dashed) {
    return (
      <svg className="chart-swatch-line" width="22" height="10" aria-hidden="true">
        <line x1="1" x2="21" y1="5" y2="5" stroke={colour} strokeWidth={dashed ? 1.5 : 2.5} strokeDasharray={dashed ? '4 3' : undefined} strokeLinecap="round" />
      </svg>
    );
  }
  return <span aria-hidden="true" className="chart-swatch" style={{ background: colour }} />;
}

/** Who is who: always there for more than one series, so identity never rests on colour alone */
function Legend({ series, kind, comparison, comparisonName }: { series: readonly ChartSeries[]; kind: ChartKind; comparison: 'series' | 'total' | null; comparisonName: string }) {
  if (series.length <= 1 && !comparison) return <div />;
  return (
    <ul className="chart-legend" aria-label="Legend">
      {series.map((s) => (
        <li key={s.key}>
          <Swatch colour={s.colour} kind={kind} />
          <span>{s.label}</span>
        </li>
      ))}
      {comparison && (
        <li>
          <Swatch colour="var(--sc-text)" kind={kind} dashed />
          <span>{comparison === 'total' ? `${comparisonName} (total)` : comparisonName}</span>
        </li>
      )}
    </ul>
  );
}

/**
 * Every value of the chart as a table. Always there for screen readers; shown on demand for everyone
 * else, in its own scrolling box so a long period never widens the page.
 */
function DataTable({ id, visible, title, buckets, unit, series, comparisonName }: { id: string; visible: boolean; title: string; buckets: readonly string[]; unit: 'day' | 'week'; series: readonly ChartSeries[]; comparisonName: string }) {
  const compared = series.filter((s) => s.comparison);
  return (
    <div id={id} className={visible ? 'chart-table' : 'visually-hidden'} {...(visible && { tabIndex: 0, role: 'region', 'aria-label': `${title}: the values` })}>
    <table className="table">
      <caption>{title}: the values</caption>
      <thead>
        <tr>
          <th scope="col">{unit === 'week' ? 'Week of' : 'Day'}</th>
          {series.map((s) => (
            <th key={s.key} scope="col">
              {s.label}
            </th>
          ))}
          {compared.map((s) => (
            <th key={`${s.key}-prev`} scope="col">
              {s.label}, {comparisonName.toLowerCase()}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {buckets.map((b, i) => (
          <tr key={b}>
            <th scope="row">{dayLabel(b, true)}</th>
            {series.map((s) => (
              <td key={s.key}>{s.values[i] === null ? 'not read' : full(s.values[i] ?? 0)}</td>
            ))}
            {compared.map((s) => (
              <td key={`${s.key}-prev`}>{s.comparison?.[i] === null || s.comparison?.[i] === undefined ? '—' : full(s.comparison[i] ?? 0)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

type KindlessProps = Omit<TimeChartProps, 'kind'>;
export const LineChart = (props: KindlessProps) => <TimeChart {...props} kind="line" />;
export const AreaChart = (props: KindlessProps) => <TimeChart {...props} kind="area" />;
export const BarChart = (props: KindlessProps) => <TimeChart {...props} kind="bar" />;
