import { Floor, Halftone, INK, LINE, Letters, PAPER, Parcel, Scene, SHEET, Stamped, YELLOW, type IllustrationProps } from './kit';

/** Launch a repo: a parcel being taped shut and labelled, the label already addressed to the whole world */
export function Sealing(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={74} cy={62} r={46} />
      <Floor y={210} />
      <Parcel x={40} y={96} w={150} h={106} depth={30} fill={PAPER} offset={7}>
        {/* The tape, over the lid and down the front */}
        <rect x={98} y={96} width={16} height={106} fill={YELLOW} stroke={INK} strokeWidth={3} />
        <path d="M106 96L128 83" stroke={INK} strokeWidth={3} />
        {/* The label, stuck on slightly crooked */}
        <g transform="rotate(-4 153 156)">
          <rect x={122} y={130} width={62} height={52} fill={SHEET} stroke={INK} strokeWidth={3} />
          <Letters x={130} y={145} size={8} face="mono" anchor="start">
            TO:
          </Letters>
          <Letters x={130} y={159} size={10} anchor="start">
            The world
          </Letters>
          <path d="M130 168H176M130 175H162" stroke={INK} strokeWidth={2.5} />
        </g>
        <g fill={INK} stroke="none">
          <rect x={54} y={168} width={32} height={6} rx={2} />
          <rect x={54} y={180} width={22} height={5} rx={2} />
        </g>
      </Parcel>
      {/* The tape dispenser: a ring of tape, its handle and the strip trailing to the parcel */}
      <circle cx={266} cy={172} r={26} fill={YELLOW} stroke={INK} />
      <circle cx={266} cy={172} r={12} stroke={INK} strokeWidth={3} />
      <circle cx={266} cy={172} r={4} fill={INK} stroke="none" />
            <Stamped offset={4} fill={INK} shape={(p) => <rect x={250} y={196} width={32} height={12} rx={3} {...p} />} />
      <path d="M240 156C232 146 226 140 220 140" stroke={LINE} strokeWidth={3} strokeDasharray="1 8" />
    </Scene>
  );
}
