import { Halftone, INK, LINE, Letters, PAPER, Parcel, Scene, SHEET, Stamped, YELLOW, type IllustrationProps } from './kit';

/** Onboarding, the brand: a repo goes in one side and comes out a parcel with your return address */
export function OnboardBrand(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={244} cy={70} r={56} />
      {/* The repo: a card with a branch on it */}
      <g transform="rotate(-6 78 124)">
        <Stamped offset={6} fill={INK} shape={(p) => <rect x={36} y={78} width={84} height={96} rx={12} {...p} />} />
        <g stroke={SHEET} strokeWidth={4}>
          <path d="M66 100V152" />
          <path d="M66 140C66 124 94 128 94 112" />
        </g>
        <g fill={YELLOW} stroke={SHEET} strokeWidth={3}>
          <circle cx={66} cy={100} r={6} />
          <circle cx={66} cy={154} r={6} />
          <circle cx={94} cy={108} r={6} />
        </g>
      </g>
      <path d="M134 124H166" stroke={LINE} strokeDasharray="2 9" />
      <path d="M160 114L170 124L160 134" stroke={LINE} />
      <Parcel x={180} y={112} w={88} h={84} depth={30} fill={PAPER}>
        <Stamped offset={3} fill={YELLOW} shape={(p) => <rect x={190} y={126} width={68} height={50} rx={3} strokeWidth={3} {...p} />} />
        <Letters x={198} y={142} size={10} anchor="start">
          From: you
        </Letters>
        <g fill={INK} stroke="none">
          <rect x={198} y={150} width={34} height={5} rx={2} />
          <rect x={198} y={160} width={24} height={5} rx={2} />
        </g>
        <rect x={236} y={150} width={16} height={16} rx={4} fill={YELLOW} stroke={INK} strokeWidth={2} />
        <circle cx={244} cy={158} r={3.5} fill={INK} stroke="none" />
      </Parcel>
    </Scene>
  );
}
