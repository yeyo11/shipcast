import { Icon } from '../kit/Icon';
import { hasGlyph, NetworkGlyph as Mark } from '../kit/NetworkGlyph';

/**
 * A network's mark in the text colour, as the boards inline it (the kit's NetworkGlyph). A source of
 * numbers or an AI provider with no mark of its own takes the line icon of what it does, not a letter.
 */
export function NetworkGlyph({ network, size = 19 }: { network: { id: string; channel?: string | undefined; ai?: boolean | undefined }; size?: number }) {
  const key = network.channel ?? network.id;
  if (hasGlyph(key)) return <Mark channel={key} size={size} />;
  return <Icon name={network.ai ? 'assist' : 'stats'} size={size} />;
}
