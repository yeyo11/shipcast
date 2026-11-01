import { Icon } from '../kit/Icon';
import { hasGlyph, NetworkGlyph as Mark, SOURCE_ICON } from '../kit/NetworkGlyph';

/**
 * A network's mark in the text colour, as the boards inline it (the kit's NetworkGlyph). A source of
 * numbers or an AI provider takes the line icon of what it does (the kit's SOURCE_ICON); one the kit
 * does not know yet still gets the chart or the assistant's icon, never a letter or a blank tile.
 */
export function NetworkGlyph({ network, size = 19 }: { network: { id: string; channel?: string | undefined; ai?: boolean | undefined }; size?: number }) {
  const key = network.channel ?? network.id;
  if (hasGlyph(key) || SOURCE_ICON[key]) return <Mark channel={key} size={size} />;
  return <Icon name={network.ai ? 'assist' : 'stats'} size={size} />;
}
