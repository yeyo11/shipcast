import { INK, LINE, SHEET, Stamped } from './kit';

/** The belt, shared by the automation scene and the onboarding's automation step */
export function Conveyor({ x, y, width }: { x: number; y: number; width: number }) {
  const rollers: number[] = [];
  for (let cx = x + 12; cx <= x + width - 12; cx += 22) rollers.push(cx);
  return (
    <g>
      <path d={`M${x + width - 30} ${y + 18}V${y + 54}M${x + 30} ${y + 18}V${y + 54}`} stroke={LINE} strokeWidth={4} />
      <Stamped offset={5} fill={INK} shape={(p) => <rect x={x} y={y} width={width} height={20} rx={10} {...p} />} />
      <g fill={SHEET} stroke="none">
        {rollers.map((cx) => (
          <circle key={cx} cx={cx} cy={y + 10} r={3.5} />
        ))}
      </g>
    </g>
  );
}
