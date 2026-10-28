import type { Published } from '@shipcast/connectors';
import { draftBody, type ChannelDefinition } from '@shipcast/schema';
import type { PublishStrategy } from '../publish.ts';

/** A network whose post is a text with the article's link: what most new channels are */
export interface TextPostPublisher {
  publish(post: { text: string; link: string; imageUrl: string }): Promise<Published>;
}

/**
 * The run of a channel whose piece is a `text` and whose draft is one file: the draft's body as
 * merged (the owner's edits), else the pack's text, with the article's link and the launch image. A
 * new short-post network needs no publishing code of its own, only this in its adapter.
 */
export function textPostStrategy(definition: Pick<ChannelDefinition, 'id' | 'pack' | 'draft'>): PublishStrategy<TextPostPublisher> {
  return {
    run(context, publisher) {
      const piece = (context.pack as Record<string, unknown>)[definition.pack.key] as { text?: unknown } | undefined;
      if (typeof piece?.text !== 'string') return undefined;
      const text = piece.text;
      return async () => {
        const draft = definition.draft ? await context.read(`${context.dir}/${definition.draft.file('').name}`) : undefined;
        return publisher.publish({ text: draft === undefined ? text : draftBody(draft), link: `${context.articleUrl}?ref=${definition.id}`, imageUrl: context.mediaUrl('og.jpg') });
      };
    },
  };
}
