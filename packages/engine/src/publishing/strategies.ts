import type { Published } from '@shipcast/connectors';
import { draftBody, type ChannelDefinition, type LinkTracking } from '@shipcast/schema';
import type { PublishContext, PublishStrategy } from '../publish.ts';

/**
 * A network whose post is a text with the article's link: what most new channels are. `tracking` is
 * the launch's, for the adapter to tag the link with (docs/tracking.md); the connector never sees it.
 */
export interface TextPostPublisher {
  publish(post: { text: string; link: string; imageUrl: string }, tracking?: LinkTracking): Promise<Published>;
}

/**
 * The run of a channel whose piece is a `text` and whose draft is one file: the draft's body as
 * merged (the owner's edits), else the pack's text, with the article's link and the launch image. A
 * new short-post network needs no publishing code of its own, only this in its adapter. `link` is the
 * article the post links, the lead one unless the channel has a language of its own in brand.yml.
 */
export function textPostStrategy(
  definition: Pick<ChannelDefinition, 'id' | 'pack' | 'draft'>,
  link: (context: PublishContext) => string = (context) => context.articleUrl,
): PublishStrategy<TextPostPublisher> {
  return {
    run(context, publisher) {
      const piece = (context.pack as Record<string, unknown>)[definition.pack.key] as { text?: unknown } | undefined;
      if (typeof piece?.text !== 'string') return undefined;
      const text = piece.text;
      return async () => {
        const draft = definition.draft ? await context.read(`${context.dir}/${definition.draft.file('').name}`) : undefined;
        return publisher.publish({ text: draft === undefined ? text : draftBody(draft), link: `${link(context)}?ref=${definition.id}`, imageUrl: context.mediaUrl('og.jpg') }, context.tracking);
      };
    },
  };
}
