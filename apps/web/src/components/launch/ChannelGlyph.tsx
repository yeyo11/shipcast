import { CHANNEL_NAMES } from '../../server/view';

export { NetworkGlyph as ChannelGlyph } from '../kit/NetworkGlyph';

/** A channel's name as the app writes it everywhere */
export const channelTitle = (channel: string) => CHANNEL_NAMES[channel] ?? channel;
