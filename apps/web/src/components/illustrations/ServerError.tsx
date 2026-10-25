import { FAILURE, Floor, Halftone, INK, LINE, Letters, ON_FAILURE, PAPER, Parcel, Scene, scallops, Stamped, type IllustrationProps } from './kit';

/** 500: a parcel that went through the machine badly, a spring out of the tear, sealed "Damaged" */
export function ServerError(props: IllustrationProps) {
  return (
    <Scene {...props}>
      <Halftone cx={92} cy={74} r={58} />
      <Floor y={206} />
      <Parcel x={62} y={104} w={136} h={98} depth={44} fill={PAPER}>
        {/* The tear, and what came out of it */}
        <path d="M86 132L102 122L112 136L128 118L142 132L156 122L166 140L154 158L140 150L124 164L108 152L92 160Z" fill={INK} stroke={INK} strokeWidth={3} />
        <path d="M128 142L144 128L114 120L144 108L114 96L144 84L114 72L136 62" stroke={LINE} strokeWidth={3.5} />
        <circle cx={140} cy={56} r={7} fill={PAPER} stroke={INK} />
        {/* "This side up", upside down */}
        <g stroke={INK} strokeWidth={3}>
          <path d="M218 128V150M211 143L218 151L225 143" />
          <path d="M232 120V142M225 135L232 143L239 135" />
        </g>
        <Letters x={76} y={192} size={11} face="mono" anchor="start">
          500
        </Letters>
      </Parcel>
      <g transform="rotate(-14 222 168)">
        <Stamped offset={5} fill={FAILURE} shape={(p) => <path d={scallops(222, 168, 40, 20)} {...p} />} />
        <circle cx={222} cy={168} r={30} stroke={ON_FAILURE} strokeWidth={2} strokeDasharray="3 4" />
        <Letters x={222} y={172} size={11} fill={ON_FAILURE}>
          Damaged
        </Letters>
      </g>
    </Scene>
  );
}
