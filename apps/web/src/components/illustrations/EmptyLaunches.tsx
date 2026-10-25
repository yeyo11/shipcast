import { Floor, Halftone, INK, LINE, PAPER, SHADOW, SHEET, Scene, Stamped, useShade, type IllustrationProps } from './kit';

/** No launches yet: an open box with nothing in it but a moth on its way out */
export function EmptyLaunches(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={232} cy={70} r={54} />
      <Floor y={206} />
      <OpenBox />
      {/* The moth, and its loops out of the box */}
      <path d="M166 106C142 92 196 82 170 70C154 62 150 52 160 46" stroke={LINE} strokeWidth={3} strokeDasharray="1 8" />
      <g transform="rotate(-18 172 38)">
        <ellipse cx={162} cy={36} rx={11} ry={8} fill={SHEET} stroke={INK} strokeWidth={3} />
        <ellipse cx={182} cy={36} rx={11} ry={8} fill={SHEET} stroke={INK} strokeWidth={3} />
        <rect x={169} y={30} width={6} height={16} rx={3} fill={INK} stroke="none" />
      </g>
    </Scene>
  );
}

function OpenBox() {
  const shade = useShade();
  return (
    <g>
      {/* Flaps first, so the box's rim sits over their hinges */}
      <Stamped offset={5} fill={PAPER} shape={(p) => <path d="M104 102L118 66H256L254 102Z" {...p} />} />
      <Stamped offset={5} fill={PAPER} shape={(p) => <path d="M68 122L104 102L80 74L42 96Z" {...p} />} />
      <Stamped offset={5} fill={PAPER} shape={(p) => <path d="M218 122L254 102L292 118L256 140Z" {...p} />} />
      <path d="M68 122L104 102H254V182L218 202H68Z" transform="translate(6 6)" fill={SHADOW} stroke={SHADOW} />
      {/* The empty inside */}
      <path d="M68 122L104 102H254L218 122Z" fill={INK} stroke={INK} />
      <path d="M218 122L254 102V182L218 202Z" fill={PAPER} stroke={INK} />
      <path d="M218 122L254 102V182L218 202Z" fill={shade} stroke="none" />
      <path d="M68 122H218V202H68Z" fill={PAPER} stroke={INK} />
      <path d="M126 122V150M160 122V150" stroke={INK} strokeWidth={3} />
      <rect x={84} y={166} width={44} height={8} rx={2} fill={INK} stroke="none" />
      <rect x={84} y={180} width={28} height={6} rx={2} fill={INK} stroke="none" />
    </g>
  );
}
