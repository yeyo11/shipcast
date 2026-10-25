import { Conveyor } from './Conveyor';
import { Floor, Halftone, INK, LINE, Letters, PAPER, Parcel, Scene, SHEET, Stamped, YELLOW, type IllustrationProps } from './kit';

/** Automation: the sorting machine sending parcels down the belt, one of them a little too eager */
export function Automation(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={250} cy={60} r={50} />
      <Floor y={210} />
      <Conveyor x={110} y={156} width={190} />
      <path d="M48 176V210M124 176V210" stroke={LINE} strokeWidth={4} />
      <Stamped offset={7} fill={PAPER} shape={(p) => <rect x={30} y={48} width={112} height={128} rx={8} {...p} />} />
      <rect x={124} y={112} width={26} height={44} rx={3} fill={INK} stroke={INK} />
      <rect x={44} y={62} width={84} height={26} rx={4} fill={INK} stroke={INK} />
      <Letters x={86} y={82} size={16} fill={YELLOW}>
        Sort
      </Letters>
      <circle cx={60} cy={112} r={11} fill={YELLOW} stroke={INK} strokeWidth={3} />
      <path d="M60 112L66 104" stroke={INK} strokeWidth={3} />
      <g fill={INK} stroke="none">
        <circle cx={88} cy={106} r={4} />
        <circle cx={102} cy={106} r={4} />
        <rect x={82} y={118} width={32} height={6} rx={2} />
      </g>
      <path d="M44 140H128M44 152H128" stroke={INK} strokeWidth={3} />
      <Parcel x={164} y={126} w={32} h={28} depth={12} fill={PAPER} offset={4} />
      {/* The eager one, mid-hop */}
      <g transform="rotate(10 246 104)">
        <Parcel x={226} y={94} w={38} h={32} depth={14} fill={YELLOW} offset={4}>
          <rect x={240} y={94} width={9} height={32} fill={SHEET} stroke={INK} strokeWidth={2.5} />
        </Parcel>
      </g>
      <path d="M226 142C232 136 240 136 246 142M256 142C262 136 270 136 276 142" stroke={LINE} strokeWidth={3} />
    </Scene>
  );
}
