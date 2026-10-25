import { Halftone, INK, LINE, Letters, PAPER, SHADOW, Scene, Stamped, YELLOW, type IllustrationProps } from './kit';

/** No drafts: a pad of blank labels and a pencil that started a line and thought better of it */
export function EmptyDrafts(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={236} cy={66} r={54} />
      <g transform="rotate(-4 150 130)">
        <Stamped offset={14} fill={PAPER} shape={(p) => <rect x={92} y={70} width={132} height={140} rx={6} {...p} />} />
        {/* The sheets under the top one */}
        <rect x={100} y={78} width={132} height={140} rx={6} fill={PAPER} stroke={INK} />
        <rect x={96} y={74} width={132} height={140} rx={6} fill={PAPER} stroke={INK} />
        <rect x={92} y={70} width={132} height={140} rx={6} fill={PAPER} stroke={INK} />
        <rect x={86} y={58} width={144} height={24} rx={5} fill={INK} stroke={INK} />
        <circle cx={112} cy={70} r={4} fill={PAPER} stroke="none" />
        <circle cx={204} cy={70} r={4} fill={PAPER} stroke="none" />
        <Letters x={108} y={108} size={13} anchor="start">
          To:
        </Letters>
        <g stroke={INK} strokeWidth={2} strokeDasharray="2 6">
          <path d="M172 104H206" />
          <path d="M108 128H206" />
          <path d="M108 150H206" />
          <path d="M108 172H170" />
        </g>
        <path d="M138 102C144 94 148 108 154 100C158 95 160 104 166 101" stroke={INK} strokeWidth={2.5} />
      </g>
      {/* The pencil, put down */}
      <g transform="rotate(-38 236 164)">
        <path d="M166 154H292V174H166Z" transform="translate(5 5)" fill={SHADOW} stroke={SHADOW} />
        <path d="M188 154H272V174H188Z" fill={YELLOW} stroke={INK} />
        <path d="M188 154L166 164L188 174Z" fill={PAPER} stroke={INK} />
        <path d="M172 161L166 164L172 167Z" fill={INK} stroke={INK} strokeWidth={2} />
        <path d="M272 154H286C290 154 292 158 292 164C292 170 290 174 286 174H272Z" fill={PAPER} stroke={INK} />
        <path d="M272 154V174M278 154V174" stroke={INK} strokeWidth={3} />
        <path d="M194 164H264" stroke={INK} strokeWidth={2} />
      </g>
      <path d="M40 186H64M46 196H58" stroke={LINE} strokeWidth={3} />
    </Scene>
  );
}
