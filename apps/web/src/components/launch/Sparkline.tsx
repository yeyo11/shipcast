/*
 * A number's history as a small line, drawn as inline SVG with no chart library: the launch page
 * needs one per piece, and /stats' visx charts are another section's. Decorative to assistive
 * technology, since the number beside it says the value and the label says how many readings.
 */

/** The polyline's points for values in a width × height box, oldest at the left; flat in the middle when nothing changes */
export function sparkPoints(values: readonly number[], width: number, height: number, pad = 2): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  return values
    .map((v, i) => {
      const x = values.length > 1 ? pad + i * step : width / 2;
      const y = span === 0 ? height / 2 : pad + (height - pad * 2) * (1 - (v - min) / span);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

export function Sparkline({ values, width = 72, height = 22 }: { values: readonly number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const points = sparkPoints(values, width, height);
  const last = points.split(' ').at(-1)?.split(',') ?? [];
  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" focusable="false">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
      {last.length === 2 && <circle cx={last[0]} cy={last[1]} r="2.5" fill="var(--sc-yellow)" stroke="currentColor" strokeWidth="1" />}
    </svg>
  );
}
