import type { NewLaunchSource } from '../repositories/index.ts';
import { sha256Hex } from '../media/store.ts';
import { fetchGuarded, type GuardedFetchOptions } from './fetch-url.ts';
import { htmlToMarkdown } from './html.ts';

/** A page's text as an analysis reads it: HTML turned into Markdown, plain text and Markdown as they are */
export type PageFetcher = (url: string) => Promise<NewLaunchSource>;

/**
 * A page as a launch's source: fetched once by Shipcast through the guarded fetcher (never by the
 * model), turned into Markdown, and hashed, so a later change to the page is a different source
 * rather than a silent one. A page the fetcher refuses throws its UrlRefused.
 */
export function pageFetcher(options: GuardedFetchOptions = {}): PageFetcher {
  return async (url) => {
    const page = await fetchGuarded(url, options);
    const html = page.contentType === 'text/html' || page.contentType === 'application/xhtml+xml';
    const converted = html ? htmlToMarkdown(page.text, page.url) : { markdown: page.text.trim() };
    return {
      kind: 'url',
      role: 'context',
      url: page.url,
      fetchedAt: new Date().toISOString(),
      httpStatus: page.status,
      contentType: page.contentType,
      text: converted.markdown,
      meta: { ...('title' in converted && converted.title && { title: converted.title }), ...(page.url !== url && { requested: url }) },
      contentHash: sha256Hex(converted.markdown),
    };
  };
}
