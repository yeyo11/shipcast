import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, currentCorrelation, currentOrigin, type LoggerOptions, MemoryLogger, prettyLine, REDACTED, redactFields, withCorrelation, withOrigin } from '../src/index.ts';

function capture(options: Omit<LoggerOptions, 'destination'> = {}) {
  const lines: string[] = [];
  const log = createLogger({ env: {}, ...options, destination: { write: (line) => void lines.push(line) } });
  const entries = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { log, lines, entries };
}

test('the pino logger writes one JSON line per entry, with the level as a label and the fields', () => {
  const { log, entries } = capture({ bindings: { process: 'web' } });
  log.info('published', { launch: 12, channel: 'mastodon' });
  const [entry] = entries();
  assert.equal(entry?.level, 'info');
  assert.equal(entry?.msg, 'published');
  assert.equal(entry?.launch, 12);
  assert.equal(entry?.channel, 'mastodon');
  assert.equal(entry?.process, 'web');
  assert.match(String(entry?.time), /^\d{4}-\d{2}-\d{2}T/);
});

test('the level comes from SHIPCAST_LOG_LEVEL, then info; an unknown one is ignored', () => {
  const quiet = capture({ env: { SHIPCAST_LOG_LEVEL: 'warn' } });
  quiet.log.info('hidden');
  quiet.log.warn('shown');
  assert.deepEqual(
    quiet.entries().map((e) => e.msg),
    ['shown'],
  );

  const fallback = capture({ env: { SHIPCAST_LOG_LEVEL: 'loud' } });
  fallback.log.debug('hidden');
  fallback.log.info('shown');
  assert.equal(fallback.lines.length, 1);

  const verbose = capture({ env: { SHIPCAST_LOG_LEVEL: 'DEBUG' } });
  verbose.log.debug('shown');
  assert.equal(verbose.lines.length, 1);
});

test('secret-looking keys are masked at any depth, in fields and in bindings; counts stay', () => {
  const { log, entries } = capture();
  log
    .child({ apiKey: 'k-1', module: 'connect' })
    .error('refused', { headers: { Authorization: 'Bearer abc', accept: 'json' }, body: [{ access_token: 'tok' }], password: 'pw', outputTokens: 512, cookie: null });
  const [entry] = entries();
  assert.equal(entry?.apiKey, REDACTED);
  assert.equal(entry?.module, 'connect');
  assert.deepEqual(entry?.headers, { Authorization: REDACTED, accept: 'json' });
  assert.deepEqual(entry?.body, [{ access_token: REDACTED }]);
  assert.equal(entry?.password, REDACTED);
  assert.equal(entry?.outputTokens, 512);
  assert.equal(entry?.cookie, null);
  assert.ok(!JSON.stringify(entry).includes('abc'));
});

test('redactFields survives cycles and leaves errors to their serializer', () => {
  const cyclic: Record<string, unknown> = { name: 'a' };
  cyclic.self = cyclic;
  assert.deepEqual(redactFields(cyclic), { name: 'a', self: '[circular]' });
  const error = new Error('boom');
  assert.equal((redactFields({ err: error }) as { err: unknown }).err, error);
});

test('errors are serialized with their message and stack', () => {
  const { log, entries } = capture();
  log.error('publish failed', { err: new Error('boom') });
  const err = entries()[0]?.err as { message?: string; stack?: string; type?: string };
  assert.equal(err.message, 'boom');
  assert.equal(err.type, 'Error');
  assert.match(String(err.stack), /boom/);
});

test('every line inside withCorrelation carries its ids and the work’s origin, nested ones added', async () => {
  const { log, entries } = capture();
  log.info('outside');
  await withOrigin('job:publish', () =>
    withCorrelation({ jobId: 'j-1' }, async () => {
      await Promise.resolve();
      log.info('inside');
      await withCorrelation({ requestId: 'r-9' }, async () => log.child({ step: 'post' }).info('deeper'));
    }),
  );
  const [outside, inside, deeper] = entries();
  assert.equal(outside?.jobId, undefined);
  assert.equal(outside?.origin, undefined);
  assert.equal(inside?.jobId, 'j-1');
  assert.equal(inside?.origin, 'job:publish');
  assert.equal(deeper?.jobId, 'j-1');
  assert.equal(deeper?.requestId, 'r-9');
  assert.equal(deeper?.step, 'post');
});

test('the correlation lives in the telemetry origin store: an origin inside keeps the ids, and the probe stays', () => {
  withOrigin(
    'page:/',
    () =>
      withCorrelation({ requestId: 'r-1' }, () => {
        assert.equal(currentOrigin().probe, true);
        withOrigin('fn:getLaunch', () => {
          assert.equal(currentOrigin().name, 'fn:getLaunch');
          assert.deepEqual(currentCorrelation(), { requestId: 'r-1' });
        });
      }),
    { probe: true },
  );
  assert.deepEqual(currentCorrelation(), {});
});

test('SHIPCAST_LOG_FORMAT=pretty writes readable lines', () => {
  const { log, lines } = capture({ env: { SHIPCAST_LOG_FORMAT: 'pretty' } });
  withCorrelation({ jobId: 'j-2' }, () => log.warn('rate limited', { network: 'bluesky', wait: '30 s' }));
  assert.match(lines[0] ?? '', /^\d{2}:\d{2}:\d{2}\.\d{3} WARN {2}rate limited jobId=j-2 network=bluesky wait="30 s"\n$/);
  assert.equal(prettyLine('not json'), 'not json');
  assert.match(prettyLine(JSON.stringify({ level: 'error', msg: 'x', err: { stack: 'Error: x\n    at y' } })), /^ERROR x\n {2}Error: x\n {6}at y\n$/);
});

test('the memory logger keeps entries, shared by its children, with bindings, ids and redaction', () => {
  const log = new MemoryLogger({ level: 'info' });
  log.debug('dropped');
  withCorrelation({ requestId: 'r-3' }, () => log.child({ module: 'oauth' }).warn('refresh failed', { refresh_token: 'rt', attempt: 2 }));
  log.error('down');
  assert.deepEqual(log.entries, [
    { level: 'warn', message: 'refresh failed', fields: { module: 'oauth', requestId: 'r-3', refresh_token: REDACTED, attempt: 2 } },
    { level: 'error', message: 'down', fields: {} },
  ]);
  assert.deepEqual(log.messages('error'), ['down']);
});
