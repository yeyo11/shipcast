import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BANNER_COOKIE, bannerCookie, readBanner } from '../src/server/banner.ts';

test('the banner preference reads from a cookie header, full by default', () => {
  assert.equal(readBanner(undefined), 'full');
  assert.equal(readBanner(''), 'full');
  assert.equal(readBanner('sc_session=abc; sc_banner=compact'), 'compact');
  assert.equal(readBanner('sc_banner=full; other=1'), 'full');
  assert.equal(readBanner('sc_banner=huge'), 'full');
  // A cookie whose name only ends like it is someone else's
  assert.equal(readBanner('xsc_banner=compact'), 'full');
});

test('the banner cookie is a year-long, site-wide, Lax preference the page can write', () => {
  const cookie = bannerCookie('compact');
  assert.ok(cookie.startsWith(`${BANNER_COOKIE}=compact;`));
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=31536000/);
  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /HttpOnly/);
  // What it writes, it reads back
  assert.equal(readBanner(cookie.split(';')[0]), 'compact');
  assert.equal(readBanner(bannerCookie('full').split(';')[0]), 'full');
});
