import { Floor, Halftone, INK, LINE, Letters, PAPER, Parcel, Scene, SHEET, Stamped, YELLOW, type IllustrationProps } from './kit';

/** Settings: a toolbox on a parcel, a wrench leaning out of it, a stamp beside it and one screw left over */
export function Toolbox(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={256} cy={62} r={44} />
      <Floor y={216} />
      <Parcel x={36} y={166} w={206} h={44} depth={26} fill={PAPER} offset={7}>
        <rect x={120} y={166} width={14} height={44} fill={SHEET} stroke={INK} strokeWidth={2.5} />
        <ellipse cx={196} cy={188} rx={22} ry={14} stroke={INK} strokeWidth={3} />
        <Letters x={196} y={192} size={11}>
          OK
        </Letters>
      </Parcel>
      {/* The wrench, behind the box and out at an angle */}
      <g transform="rotate(24 100 100)">
        <rect x={94} y={30} width={12} height={76} rx={5} fill={SHEET} stroke={INK} strokeWidth={3} />
        <circle cx={100} cy={30} r={15} fill={SHEET} stroke={INK} strokeWidth={3} />
        <rect x={94} y={10} width={12} height={20} fill={INK} stroke={INK} />
      </g>
      {/* The box: lid line, latch and a handle on top */}
      <path d="M130 108V90H178V108" stroke={INK} strokeWidth={6} />
      <Stamped offset={7} fill={YELLOW} shape={(p) => <rect x={84} y={108} width={140} height={58} rx={6} {...p} />} />
      <path d="M84 128H224" stroke={INK} strokeWidth={3} />
      <rect x={144} y={120} width={20} height={16} rx={2} fill={SHEET} stroke={INK} strokeWidth={3} />
      <circle cx={154} cy={128} r={2.5} fill={INK} stroke="none" />
      <path d="M100 150H208" stroke={INK} strokeWidth={3} strokeDasharray="2 10" />
      {/* The rubber stamp, handle up */}
      <Stamped offset={4} fill={INK} shape={(p) => <rect x={262} y={186} width={44} height={14} rx={3} {...p} />} />
      <rect x={278} y={150} width={12} height={36} fill={PAPER} stroke={INK} strokeWidth={3} />
      <Stamped offset={4} fill={YELLOW} shape={(p) => <rect x={268} y={126} width={32} height={26} rx={13} {...p} />} />
      {/* The screw that was left over, rolling off */}
      <g transform="rotate(-70 60 130)">
        <rect x={40} y={124} width={30} height={10} rx={2} fill={SHEET} stroke={INK} strokeWidth={3} />
        <rect x={28} y={120} width={12} height={18} rx={3} fill={SHEET} stroke={INK} strokeWidth={3} />
      </g>
      <path d="M40 116C34 106 30 100 28 92" stroke={LINE} strokeWidth={3} strokeDasharray="1 8" />
    </Scene>
  );
}
