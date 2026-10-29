import assert from 'node:assert/strict';
import { test } from 'node:test';
import { campaignOf, tagHtmlLinks, tagLinks, track, trackedUrl, trackUrl, trackWithinLimit, UTM_CHANNELS, utmFor } from '../src/index.ts';

const SITE = 'https://josegarrido.dev';
const utm = utmFor('bluesky', 'claudio-v1-0-0');
const TAGS = 'utm_source=bluesky&utm_medium=social&utm_campaign=claudio-v1-0-0';

test('the campaign is the launch’s: a release’s project and version, a repo gone public, an article’s slug', () => {
  assert.equal(campaignOf({ repo: 'yeyo11/shipcast', ref: 'v0.2.0' }), 'shipcast-v0-2-0');
  assert.equal(campaignOf({ repo: 'yeyo11/Claudio', ref: 'v1.0.0-beta.1' }), 'claudio-v1-0-0-beta-1');
  assert.equal(campaignOf({ repo: 'yeyo11/rea', ref: 'public:2026-10-01' }), 'rea-launch');
  assert.equal(campaignOf({ repo: 'yeyo11/launches', ref: 'article:why-local-first' }), 'why-local-first');
});

test('each channel’s source and medium; content only where the channel tells its pieces apart', () => {
  assert.deepEqual(utmFor('mastodon', 'c'), { source: 'mastodon', medium: 'social', campaign: 'c' });
  assert.deepEqual(utmFor('githubDiscussions', 'c'), { source: 'github', medium: 'social', campaign: 'c' });
  assert.deepEqual(utmFor('reddit', 'c', 'selfhosted'), { source: 'reddit', medium: 'social', campaign: 'c', content: 'selfhosted' });
  assert.deepEqual(utmFor('newsletter', 'c', 'es'), { source: 'newsletter', medium: 'email', campaign: 'c', content: 'es' });
  assert.deepEqual(utmFor('discord', 'c', 'ignored'), { source: 'discord', medium: 'social', campaign: 'c' });
  assert.deepEqual(
    Object.keys(UTM_CHANNELS).sort(),
    ['bluesky', 'discord', 'githubDiscussions', 'linkedin', 'mastodon', 'newsletter', 'reddit', 'telegram', 'threads'],
    'dev.to and Hashnode keep a clean canonical URL; Instagram has no clickable links',
  );
});

test('a link to the site loses its ref and gets the tags; its path, other parameters and fragment stay', () => {
  assert.equal(trackedUrl(`${SITE}/en/claudio/?ref=bluesky`, SITE, utm), `${SITE}/en/claudio/?${TAGS}`);
  assert.equal(trackedUrl(`${SITE}/en/claudio/`, SITE, utm), `${SITE}/en/claudio/?${TAGS}`);
  assert.equal(trackedUrl(`${SITE}/en/claudio/?lang=en#install`, SITE, utm), `${SITE}/en/claudio/?lang=en&${TAGS}#install`);
  assert.equal(trackedUrl('https://www.josegarrido.dev/en/claudio/', SITE, utm), `https://www.josegarrido.dev/en/claudio/?${TAGS}`, 'www is the same site');
});

test('a link elsewhere, a hand-tagged one and a broken one are left exactly as written', () => {
  for (const url of ['https://github.com/yeyo11/claudio?ref=bluesky', 'https://josegarrido.dev.evil.example/x', `${SITE}/en/claudio/?utm_source=friend&ref=x`, 'https://']) {
    assert.equal(trackedUrl(url, SITE, utm), url);
  }
});

test('tagLinks tags the site’s links in a text or Markdown and leaves the rest of it as written', () => {
  const text = `Out now: ${SITE}/en/claudio/?ref=bluesky. Code: https://github.com/yeyo11/claudio\nRead [the article](${SITE}/en/claudio/?ref=bluesky) (or ${SITE}/es/claudio/).`;
  assert.equal(
    tagLinks(text, SITE, utm),
    `Out now: ${SITE}/en/claudio/?${TAGS}. Code: https://github.com/yeyo11/claudio\nRead [the article](${SITE}/en/claudio/?${TAGS}) (or ${SITE}/es/claudio/?${TAGS}).`,
  );
  assert.equal(tagLinks('No links here.', SITE, utm), 'No links here.');
});

test('tagHtmlLinks tags the site’s hrefs and keeps the HTML’s ampersands escaped', () => {
  const html = `<a href="${SITE}/es/claudio/?ref=newsletter"><img src="${SITE}/og.png"></a> <a href="https://github.com/yeyo11/claudio">repo</a> <a href="{{ unsubscribe }}">x</a>`;
  const tagged = tagHtmlLinks(html, SITE, utmFor('newsletter', 'claudio-v1-0-0', 'es'));
  assert.equal(
    tagged,
    `<a href="${SITE}/es/claudio/?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=claudio-v1-0-0&amp;utm_content=es"><img src="${SITE}/og.png"></a> <a href="https://github.com/yeyo11/claudio">repo</a> <a href="{{ unsubscribe }}">x</a>`,
  );
  assert.equal(tagHtmlLinks(`<a href="${SITE}/x?a=1&amp;b=2">`, SITE, utm), `<a href="${SITE}/x?a=1&amp;b=2&amp;${TAGS.replaceAll('&', '&amp;')}">`);
});

test('without tracking a channel’s text and links go out as written', () => {
  assert.equal(track('mastodon', `${SITE}/en/x/?ref=mastodon`, undefined), `${SITE}/en/x/?ref=mastodon`);
  assert.equal(trackUrl('discord', `${SITE}/en/x/`, undefined), `${SITE}/en/x/`);
});

test('a text the tags would push over its network’s limit keeps its ?ref=', () => {
  const tracking = { site: SITE, campaign: 'claudio-v1-0-0' };
  const link = `${SITE}/en/claudio/?ref=threads`;
  const short = `Out: ${link}`;
  assert.equal(trackWithinLimit('threads', short, tracking), `Out: ${SITE}/en/claudio/?utm_source=threads&utm_medium=social&utm_campaign=claudio-v1-0-0`);
  const full = `${'a'.repeat(500 - link.length - 1)} ${link}`;
  assert.equal(full.length, 500);
  assert.equal(trackWithinLimit('threads', full, tracking), full, 'tagged it would be over 500');
});
