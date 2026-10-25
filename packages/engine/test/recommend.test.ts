import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audienceKey, channelHistory, isTimeZone, localTime, readTimezone, recommendFor, recommendTimes, saveTimezone, type HistoryPost } from '../src/index.ts';
import { memoryRegistry } from '../src/testing.ts';

const MADRID = 'Europe/Madrid';
// A Monday in summer time (CEST, UTC+2)
const SUMMER_MONDAY = new Date('2026-07-06T06:00:00.000Z');

/** A past post at a local weekday and hour in Madrid (UTC+2 all that spring and summer), weeks before the clock */
function postAt(day: number, hour: number, engagement: number, weeksAgo = 2): HistoryPost {
  // 2026-06-29 is a Monday, a week before the clock; twelve weeks back is still summer time
  const utc = Date.UTC(2026, 5, 29 + day, hour - 2) - (weeksAgo - 1) * 7 * 86_400_000;
  return { publishedAt: new Date(utc).toISOString(), engagement };
}

test('local time follows the zone’s rules on the day, summer time and the repeated hour included', () => {
  assert.deepEqual(localTime(new Date('2026-07-06T15:00:00Z'), MADRID), { day: 0, hour: 17, minute: 0, date: '2026-07-06' });
  assert.deepEqual(localTime(new Date('2026-12-07T15:00:00Z'), MADRID), { day: 0, hour: 16, minute: 0, date: '2026-12-07' });
  // 25 October 2026: 03:00 CEST goes back to 02:00 CET, so 02:30 happens twice
  assert.equal(localTime(new Date('2026-10-25T00:30:00Z'), MADRID).hour, 2);
  assert.equal(localTime(new Date('2026-10-25T01:30:00Z'), MADRID).hour, 2);
  // 29 March 2026: 02:00 CET jumps to 03:00 CEST
  assert.equal(localTime(new Date('2026-03-29T01:00:00Z'), MADRID).hour, 3);
  assert.deepEqual(localTime(new Date('2026-07-06T22:30:00Z'), 'Asia/Kolkata'), { day: 1, hour: 4, minute: 0, date: '2026-07-07' });
});

test('time zones are IANA names; offsets and made-up zones are refused, and Madrid is the default', async () => {
  assert.ok(isTimeZone('Europe/Madrid'));
  assert.ok(isTimeZone('America/Argentina/Buenos_Aires'));
  assert.ok(isTimeZone('UTC'));
  for (const bad of ['+01:00', 'Mars/Olympus', '', 'Europe/Madrid; drop', 42]) assert.equal(isTimeZone(bad), false, String(bad));
  const registry = await memoryRegistry();
  assert.equal(await readTimezone(registry), 'Europe/Madrid');
  await saveTimezone(registry, 'America/New_York');
  assert.equal(await readTimezone(registry), 'America/New_York');
  await assert.rejects(saveTimezone(registry, 'GMT+1'));
});

test('with no history the defaults speak: Bluesky’s weekday afternoons in Madrid, one slot a day, told in local time', () => {
  const rec = recommendTimes({ channel: 'bluesky', tz: MADRID, now: SUMMER_MONDAY });
  assert.equal(rec.slots.length, 5);
  assert.equal(rec.history.used, 0);
  const dates = new Set<string>();
  for (const slot of rec.slots) {
    const local = localTime(new Date(slot.at), MADRID);
    assert.ok(local.day < 5 && local.hour >= 15 && local.hour < 19, slot.local);
    assert.equal(slot.basis, 'default');
    assert.match(slot.reason, /Bluesky’s default for a developer audience/);
    assert.equal(new Date(slot.at).getUTCHours(), local.hour - 2, 'summer time: two hours ahead of UTC');
    assert.ok(slot.local.endsWith(`${String(local.hour).padStart(2, '0')}:00`));
    dates.add(local.date);
  }
  assert.equal(dates.size, 5, 'the best hour of each day, not five hours of one');
  assert.ok(rec.slots.every((s, i) => i === 0 || s.score <= rec.slots[i - 1]!.score), 'best first');
});

test('across the end of summer time the same local hour is a different UTC hour', () => {
  // Thursday 22 October 2026, before the change on Sunday the 25th
  const rec = recommendTimes({ channel: 'devto', tz: MADRID, now: new Date('2026-10-22T00:00:00Z'), days: 7, count: 7 });
  const offsets = rec.slots.map((slot) => {
    const local = localTime(new Date(slot.at), MADRID);
    return [local.date, (local.hour - new Date(slot.at).getUTCHours() + 24) % 24];
  });
  assert.ok(offsets.some(([date, off]) => date === '2026-10-23' && off === 2), JSON.stringify(offsets));
  assert.ok(offsets.some(([date, off]) => date === '2026-10-27' && off === 1), JSON.stringify(offsets));
});

test('in a zone half an hour off UTC the slots are still on the local hour', () => {
  const rec = recommendTimes({ channel: 'mastodon', tz: 'Asia/Kolkata', now: SUMMER_MONDAY });
  assert.ok(rec.slots.every((s) => new Date(s.at).getUTCMinutes() === 30));
});

test('a few posts barely move the defaults', () => {
  // One great post on a Saturday morning, three ordinary ones on Tuesday mornings
  const history = [postAt(5, 8, 10), postAt(1, 10, 1), postAt(1, 10, 1, 3), postAt(1, 10, 1, 4)];
  const rec = recommendTimes({ channel: 'bluesky', tz: MADRID, now: SUMMER_MONDAY, history });
  assert.equal(rec.history.used, 4);
  const top = localTime(new Date(rec.slots[0]!.at), MADRID);
  assert.ok(top.day < 5 && top.hour >= 15 && top.hour < 19, `the default still leads: ${rec.slots[0]!.local}`);
  const saturday = rec.slots.find((s) => s.local.startsWith('Sat'));
  assert.ok(!saturday || saturday.score < rec.slots[0]!.score);
});

test('a history of posts takes over, and the slot says why', () => {
  const history = [
    ...Array.from({ length: 8 }, (_, i) => postAt(5, 8, 10, 2 + i)),
    ...Array.from({ length: 12 }, (_, i) => postAt(1, 16, 1, 2 + i)),
  ];
  const rec = recommendTimes({ channel: 'bluesky', tz: MADRID, now: SUMMER_MONDAY, history });
  const top = rec.slots[0]!;
  assert.match(top.local, /^Sat 2026-07-11 08:00$/);
  assert.equal(top.basis, 'history');
  assert.match(top.reason, /^your 8 posts at Sat 08:00 did 10\.0x your median on Bluesky$/);
  assert.ok(top.score > 3);
  assert.ok(!rec.slots.some((s) => s.local.startsWith('Tue') && s.local.endsWith('16:00')), 'the ordinary posts pull Tuesday 16:00 below the hours around it');
});

test('posts younger than two days are left out: their numbers are still growing', () => {
  const young = { publishedAt: new Date(SUMMER_MONDAY.getTime() - 3600_000).toISOString(), engagement: 0 };
  const rec = recommendTimes({ channel: 'bluesky', tz: MADRID, now: SUMMER_MONDAY, history: [postAt(1, 10, 1), postAt(2, 10, 1), postAt(3, 10, 1), young] });
  assert.deepEqual([rec.history.posts, rec.history.used], [4, 3]);
});

test('Instagram’s online-follower hours, in Pacific time, move its slots', () => {
  // Followers online at noon in Los Angeles: 21:00 in Madrid in July
  const hours = Array.from({ length: 24 }, (_, h) => (h === 12 ? 100 : 10));
  const rec = recommendTimes({ channel: 'instagram', tz: MADRID, now: SUMMER_MONDAY, audience: { timeZone: 'America/Los_Angeles', hours } });
  assert.equal(rec.audience, true);
  const top = rec.slots[0]!;
  assert.equal(localTime(new Date(top.at), MADRID).hour, 21);
  assert.equal(top.basis, 'audience');
  assert.match(top.reason, /% more of your Instagram followers are online at 21:00/);
});

test('the registry’s history is the stats ranking’s popularity per network, and only what went out', async () => {
  const registry = await memoryRegistry();
  // Three Bluesky posts with 6, 1 and 2 likes: the stats ranking scores them 7/3, 2/3 and 1 against the median of 2
  const likes = [6, 1, 2];
  const ids: number[] = [];
  for (const [i, n] of likes.entries()) {
    const { launch } = await registry.claim({ repo: 'yeyo11/claudio', ref: `v${i + 1}`, trigger: 'release', kind: 'launch', brand: 'personal' });
    const { post } = await registry.recordPost({ launchId: launch.id, channel: 'bluesky', externalId: `at://${i}`, url: `https://bsky.app/${i}` });
    await registry.recordMetrics(launch.id, 'bluesky', { likes: 0, reposts: 0, replies: 0, quotes: 0 }, new Date('2026-07-01T00:00:00Z'), post.id);
    await registry.recordMetrics(launch.id, 'bluesky', { likes: n, reposts: 0, replies: 0, quotes: 0 }, new Date('2026-07-02T00:00:00Z'), post.id);
    ids.push(post.id);
  }
  const { launch: other } = await registry.claim({ repo: 'yeyo11/claudio', ref: 'v9', trigger: 'release', kind: 'launch', brand: 'personal' });
  await registry.schedulePost(other.id, 'bluesky', new Date('2030-01-01T00:00:00Z'));
  const history = await channelHistory(registry, 'bluesky', SUMMER_MONDAY);
  assert.equal(history.length, 3, 'the scheduled piece is not history');
  assert.deepEqual(
    history.map((h) => Math.round(h.engagement * 1000) / 1000).sort(),
    [7 / 3, 2 / 3, 1].map((x) => Math.round(x * 1000) / 1000).sort(),
  );
  assert.deepEqual(await channelHistory(registry, 'telegram'), [], 'Telegram reads no numbers');

  // The Instagram audience is read from the account's kept hours
  const account = await registry.addAccount({ network: 'instagram', brand: 'personal', label: '@me', settings: {} });
  await registry.setCursor(audienceKey(account.id), JSON.stringify({ timeZone: 'America/Los_Angeles', hours: Array.from({ length: 24 }, (_, h) => h), takenAt: '2026-07-01T00:00:00Z' }));
  assert.equal((await recommendFor(registry, 'instagram', { now: SUMMER_MONDAY })).audience, true);
  await assert.rejects(recommendFor(registry, 'reddit'));
});
