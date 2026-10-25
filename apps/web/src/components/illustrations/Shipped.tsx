import { Halftone, INK, Letters, Perforation, Scene, SHEET, Stamped, YELLOW, type IllustrationProps } from './kit';

/** Shipped: an envelope with its stamp cancelled by the postmark, right on time */
export function Shipped(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={66} cy={56} r={48} />
      <g transform="rotate(-3 160 124)">
        <Stamped offset={8} fill={SHEET} shape={(p) => <rect x={30} y={44} width={262} height={162} rx={6} {...p} />} />
        {/* The postage stamp: the mark on yellow, a version for its value */}
        <rect x={194} y={58} width={82} height={98} fill={YELLOW} stroke={INK} />
        <Perforation x={194} y={58} w={82} h={98} step={10} under={SHEET} />
        <rect x={204} y={68} width={62} height={78} stroke={INK} strokeWidth={2.5} />
        <rect x={218} y={82} width={34} height={34} rx={9} fill={YELLOW} stroke={INK} strokeWidth={3} />
        <circle cx={235} cy={99} r={7} fill={INK} stroke="none" />
        <Letters x={235} y={136} size={10} face="mono">
          v1.0.0
        </Letters>
        {/* The postmark and its cancelling waves */}
        <g stroke={INK}>
          <circle cx={168} cy={108} r={42} strokeWidth={3.5} />
          <circle cx={168} cy={108} r={34} strokeWidth={1.5} />
          <path d="M212 92C226 84 240 100 254 92S282 84 292 90M212 108C226 100 240 116 254 108S282 100 292 106M212 124C226 116 240 132 254 124S282 116 292 122" strokeWidth={3} />
        </g>
        <Letters x={168} y={92} size={9} face="mono">
          ON TIME
        </Letters>
        <Letters x={168} y={115} size={16}>
          Shipped
        </Letters>
        <Letters x={168} y={132} size={9} face="mono">
          25 OCT
        </Letters>
        <g fill={INK} stroke="none">
          <rect x={52} y={160} width={70} height={9} rx={2} />
          <rect x={52} y={176} width={110} height={6} rx={2} />
          <rect x={52} y={188} width={84} height={6} rx={2} />
        </g>
      </g>
    </Scene>
  );
}
