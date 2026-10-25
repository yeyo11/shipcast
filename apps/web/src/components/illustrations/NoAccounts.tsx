import { Floor, Halftone, INK, LINE, PAPER, Scene, Stamped, YELLOW, type IllustrationProps } from './kit';

/** No accounts: a megaphone with its plug out of the wall, so nothing comes out but dots */
export function NoAccounts(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={96} cy={70} r={56} />
      <Floor y={208} />
      {/* The socket on the wall, empty */}
      <Stamped offset={5} fill={PAPER} shape={(p) => <rect x={262} y={140} width={36} height={48} rx={7} {...p} />} />
      <rect x={272} y={154} width={5} height={14} rx={2} fill={INK} stroke="none" />
      <rect x={283} y={154} width={5} height={14} rx={2} fill={INK} stroke="none" />
      <path d="M118 150C116 206 176 214 210 196" stroke={LINE} strokeWidth={5} />
      <rect x={208} y={186} width={26} height={20} rx={4} fill={INK} stroke={INK} />
      <path d="M234 191H246M234 201H246" stroke={INK} strokeWidth={4} />
      <path d="M234 191H246M234 201H246" stroke={PAPER} strokeWidth={1.5} />
      <g transform="rotate(-14 150 104)">
        <Stamped offset={7} fill={YELLOW} shape={(p) => <path d="M118 86L206 50V158L118 122Z" {...p} />} />
        <Stamped offset={5} fill={PAPER} shape={(p) => <rect x={92} y={86} width={28} height={36} rx={5} {...p} />} />
        <rect x={104} y={120} width={18} height={36} rx={5} fill={INK} stroke={INK} />
        <ellipse cx={206} cy={104} rx={15} ry={54} fill={PAPER} stroke={INK} />
        <ellipse cx={208} cy={104} rx={7} ry={40} fill={INK} stroke={INK} />
        <path d="M140 84V124" stroke={INK} strokeWidth={3} />
      </g>
      <g fill={LINE} stroke="none">
        <circle cx={240} cy={72} r={4} />
        <circle cx={256} cy={66} r={4} />
        <circle cx={272} cy={60} r={4} />
      </g>
    </Scene>
  );
}
