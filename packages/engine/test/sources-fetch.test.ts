import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { after, test } from 'node:test';
import zlib from 'node:zlib';
import { fetchGuarded, UrlRefused, type GuardedFetchOptions, type UrlRefusal } from '../src/sources/fetch-url.ts';

interface Target {
  host: string;
  port: number;
  url: string;
  /** TCP connections the server accepted */
  connections: () => number;
  /** Each request's path, in order */
  requests: string[];
  headers: http.IncomingHttpHeaders[];
}

const closers: Array<() => Promise<void>> = [];

after(async () => {
  await Promise.all(closers.map((close) => close()));
});

/** An HTTP server on a loopback address, which counts what reaches it and is closed after the tests */
async function serve(host: string, handler: http.RequestListener, port = 0): Promise<Target> {
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const requests: string[] = [];
  const headers: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    headers.push(req.headers);
    handler(req, res);
  });
  server.on('connection', (socket) => {
    connections++;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return { host, port: address.port, url: `http://${host}:${address.port}`, connections: () => connections, requests, headers };
}

function html(res: http.ServerResponse, body: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
}

const onlyFirstLoopback = (ip: string): boolean => ip === '127.0.0.1';

/** A resolver that answers from a table and counts its calls; a name it does not know fails */
function resolver(table: Record<string, Array<{ address: string; family: 4 | 6 }>>): NonNullable<GuardedFetchOptions['resolve']> & { calls: string[] } {
  const calls: string[] = [];
  const resolve = async (hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> => {
    calls.push(hostname);
    const answer = table[hostname];
    if (!answer) throw new Error(`no such host ${hostname}`);
    return answer;
  };
  return Object.assign(resolve, { calls });
}

async function refused(promise: Promise<unknown>, reason: UrlRefusal): Promise<UrlRefused> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof UrlRefused, `expected a UrlRefused, got ${String(error)}`);
    assert.equal(error.reason, reason, error.message);
    return error;
  }
  return assert.fail(`expected a ${reason} refusal`);
}

const PRIVATE_ANSWERS: Array<{ address: string; family: 4 | 6 }> = [
  { address: '127.0.0.1', family: 4 },
  { address: '10.0.0.1', family: 4 },
  { address: '192.168.1.1', family: 4 },
  { address: '172.16.0.1', family: 4 },
  { address: '169.254.169.254', family: 4 },
  { address: '100.64.0.1', family: 4 },
  { address: '::1', family: 6 },
  { address: 'fc00::1', family: 6 },
  { address: 'fe80::1', family: 6 },
  { address: '::ffff:127.0.0.1', family: 6 },
];

test('private and loopback IP literals are refused by the default policy, with nothing sent', async () => {
  const target = await serve('127.0.0.1', (_req, res) => html(res, 'secret'));
  const resolve = resolver({});
  const urls = [
    target.url,
    `http://[::ffff:127.0.0.1]:${target.port}/`,
    `http://[::ffff:7f00:1]:${target.port}/`,
    `http://0x7f.1:${target.port}/`,
    `http://2130706433:${target.port}/`,
    `http://[::1]:${target.port}/`,
    'http://10.0.0.1/',
    'http://192.168.1.1/',
    'http://172.16.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'https://127.0.0.1/',
  ];
  for (const url of urls) {
    const error = await refused(fetchGuarded(url, { resolve, timeoutMs: 2000 }), 'address');
    assert.equal(error.httpStatus, 422);
    assert.equal(error.retryable, false);
  }
  assert.deepEqual(resolve.calls, [], 'an IP literal is never resolved');
  assert.equal(target.connections(), 0);
});

test('a hostname resolving to a private or loopback address is refused by the default policy, with nothing sent', async () => {
  const target = await serve('127.0.0.1', (_req, res) => html(res, 'secret'));
  for (const answer of PRIVATE_ANSWERS) {
    const resolve = resolver({ 'internal.test': [answer] });
    await refused(fetchGuarded(`http://internal.test:${target.port}/`, { resolve, timeoutMs: 2000 }), 'address');
    assert.deepEqual(resolve.calls, ['internal.test']);
  }
  assert.equal(target.connections(), 0);
});

test('a hostname is refused when any one of its addresses is private', async () => {
  const target = await serve('127.0.0.1', (_req, res) => html(res, 'secret'));
  for (const answers of [
    [{ address: '1.1.1.1', family: 4 as const }, { address: '127.0.0.1', family: 4 as const }],
    [{ address: '127.0.0.1', family: 4 as const }, { address: '1.1.1.1', family: 4 as const }],
    [{ address: '2606:4700:4700::1111', family: 6 as const }, { address: '8.8.8.8', family: 4 as const }, { address: '10.1.2.3', family: 4 as const }],
  ]) {
    const resolve = resolver({ 'mixed.test': answers });
    await refused(fetchGuarded(`http://mixed.test:${target.port}/`, { resolve, timeoutMs: 2000 }), 'address');
  }
  assert.equal(target.connections(), 0);
});

test('a redirect to a refused IP literal is not followed', async () => {
  const inside = await serve('127.0.0.2', (_req, res) => html(res, 'internal'));
  const outside = await serve('127.0.0.1', (_req, res) => {
    res.writeHead(302, { location: `http://127.0.0.2:${inside.port}/admin` });
    res.end();
  });
  await refused(fetchGuarded(`${outside.url}/`, { allowAddress: onlyFirstLoopback }), 'address');
  assert.deepEqual(outside.requests, ['/']);
  assert.equal(inside.connections(), 0);
});

test('a redirect to a hostname resolving to a refused address is not followed', async () => {
  const inside = await serve('127.0.0.2', (_req, res) => html(res, 'internal'));
  const outside = await serve('127.0.0.1', (_req, res) => {
    res.writeHead(301, { location: `http://internal.test:${inside.port}/admin` });
    res.end();
  });
  const resolve = resolver({ 'public.test': [{ address: '127.0.0.1', family: 4 }], 'internal.test': [{ address: '127.0.0.2', family: 4 }] });
  await refused(fetchGuarded(`http://public.test:${outside.port}/`, { resolve, allowAddress: onlyFirstLoopback }), 'address');
  assert.deepEqual(resolve.calls, ['public.test', 'internal.test']);
  assert.equal(outside.requests.length, 1);
  assert.equal(inside.connections(), 0);
});

test('DNS rebinding: the connection goes to the address that was vetted, resolved once', async () => {
  const vetted = await serve('127.0.0.1', (_req, res) => html(res, '<p>the vetted one</p>'));
  const rebound = await serve('127.0.0.2', (_req, res) => html(res, '<p>internal</p>'), vetted.port);
  let calls = 0;
  const resolve = async (): Promise<Array<{ address: string; family: 4 | 6 }>> => {
    calls++;
    return [{ address: calls === 1 ? '127.0.0.1' : '127.0.0.2', family: 4 }];
  };
  const page = await fetchGuarded(`http://rebind.test:${vetted.port}/`, { resolve, allowAddress: onlyFirstLoopback });
  assert.equal(page.text, '<p>the vetted one</p>');
  assert.equal(calls, 1);
  assert.equal(vetted.requests.length, 1);
  assert.equal(vetted.headers[0]?.host, `rebind.test:${vetted.port}`, 'the Host header names the URL, not the address');
  assert.equal(rebound.connections(), 0);
});

test('the connected peer is checked again, and a refused one receives no request byte', async () => {
  let received = 0;
  let closed!: () => void;
  const serverSideClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('data', (chunk: Buffer) => {
      received += chunk.length;
    });
    socket.on('close', () => closed());
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');

  // The resolution check passes, the check of the peer the socket reached does not
  const checked: string[] = [];
  const allowAddress = (ip: string): boolean => {
    checked.push(ip);
    return checked.length === 1;
  };
  const resolve = resolver({ 'peer.test': [{ address: '127.0.0.1', family: 4 }] });
  await refused(fetchGuarded(`http://peer.test:${address.port}/`, { resolve, allowAddress, timeoutMs: 2000 }), 'address');
  await serverSideClosed;
  assert.deepEqual(checked, ['127.0.0.1', '127.0.0.1']);
  assert.equal(received, 0);
});

test('too many redirects are refused', async () => {
  const target = await serve('127.0.0.1', (req, res) => {
    const n = Number((req.url ?? '/0').slice(1));
    res.writeHead(307, { location: `/${n + 1}` });
    res.end();
  });
  await refused(fetchGuarded(`${target.url}/0`, { allowAddress: onlyFirstLoopback, maxRedirects: 3 }), 'redirects');
  assert.deepEqual(target.requests, ['/0', '/1', '/2', '/3']);
});

test('a redirect to a scheme other than http(s) is refused', async () => {
  for (const location of ['file:///etc/passwd', 'ftp://127.0.0.1/', 'gopher://127.0.0.1:6379/_INFO']) {
    const target = await serve('127.0.0.1', (_req, res) => {
      res.writeHead(302, { location });
      res.end();
    });
    await refused(fetchGuarded(`${target.url}/`, { allowAddress: onlyFirstLoopback }), 'scheme');
  }
});

test('a URL with credentials is refused, and so is a redirect to one', async () => {
  const target = await serve('127.0.0.1', (_req, res) => html(res, 'x'));
  for (const url of [`http://user:pass@127.0.0.1:${target.port}/`, `http://user@127.0.0.1:${target.port}/`, `http://:pass@127.0.0.1:${target.port}/`]) {
    const error = await refused(fetchGuarded(url, { allowAddress: onlyFirstLoopback }), 'credentials');
    assert.equal(error.httpStatus, 400);
  }
  assert.equal(target.connections(), 0);

  const redirecting = await serve('127.0.0.1', (_req, res) => {
    res.writeHead(302, { location: `http://admin:admin@127.0.0.1:${target.port}/` });
    res.end();
  });
  await refused(fetchGuarded(`${redirecting.url}/`, { allowAddress: onlyFirstLoopback }), 'credentials');
  assert.equal(target.connections(), 0);
});

test('a scheme other than http(s) is refused, and so is what is not a URL', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://127.0.0.1:70/', 'data:text/html,hi', 'javascript:alert(1)', 'ws://127.0.0.1/']) {
    await refused(fetchGuarded(url), 'scheme');
  }
  for (const url of ['', 'not a url', 'http://', '//example.com/', 'http://[fe80::1%25eth0]/']) {
    await refused(fetchGuarded(url), 'invalid');
  }
});

test('a Content-Length above the cap is refused before the body is read', async () => {
  const target = await serve('127.0.0.1', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': '5000' });
    res.end('a'.repeat(5000));
  });
  await refused(fetchGuarded(`${target.url}/`, { allowAddress: onlyFirstLoopback, maxBytes: 1000 }), 'size');
});

test('a chunked body above the cap is refused', async () => {
  const target = await serve('127.0.0.1', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    for (let i = 0; i < 10; i++) res.write('b'.repeat(500));
    res.end();
  });
  await refused(fetchGuarded(`${target.url}/`, { allowAddress: onlyFirstLoopback, maxBytes: 1000 }), 'size');
});

test('a gzip bomb is stopped by its decoded size', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(32 * 1024 * 1024, 'a'));
  assert.ok(bomb.length < 64 * 1024);
  const target = await serve('127.0.0.1', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': String(bomb.length) });
    res.end(bomb);
  });
  await refused(fetchGuarded(`${target.url}/`, { allowAddress: onlyFirstLoopback, maxBytes: 1024 * 1024 }), 'size');
});

test('a server that never answers times out', async () => {
  const target = await serve('127.0.0.1', () => {});
  const started = Date.now();
  const error = await refused(fetchGuarded(`${target.url}/`, { allowAddress: onlyFirstLoopback, timeoutMs: 300 }), 'timeout');
  assert.ok(Date.now() - started < 5000);
  assert.equal(error.retryable, true);
});

test('a body that drips slowly times out over the whole fetch', async () => {
  const target = await serve('127.0.0.1', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const drip = setInterval(() => res.write('.'), 50);
    res.on('close', () => clearInterval(drip));
  });
  const started = Date.now();
  await refused(fetchGuarded(`${target.url}/`, { allowAddress: onlyFirstLoopback, timeoutMs: 400 }), 'timeout');
  assert.ok(Date.now() - started < 5000);
});

test('a content type outside the list is refused', async () => {
  for (const type of ['image/png', 'application/octet-stream', undefined]) {
    const target = await serve('127.0.0.1', (_req, res) => {
      res.writeHead(200, type === undefined ? {} : { 'content-type': type });
      res.end('data');
    });
    await refused(fetchGuarded(`${target.url}/`, { allowAddress: onlyFirstLoopback }), 'content_type');
  }
});

test('a status outside 2xx is refused, retryable only for a server error', async () => {
  for (const [status, retryable] of [
    [404, false],
    [403, false],
    [503, true],
  ] as const) {
    const target = await serve('127.0.0.1', (_req, res) => {
      res.writeHead(status, { 'content-type': 'text/html' });
      res.end('nope');
    });
    const error = await refused(fetchGuarded(`${target.url}/`, { allowAddress: onlyFirstLoopback }), 'status');
    assert.equal(error.upstreamStatus, status);
    assert.equal(error.retryable, retryable);
  }
});

test('a page is read through its redirects, in the charset its content type names', async () => {
  const latin1 = Buffer.from('<html><head><title>Café</title></head><body><p>Niño, ¿qué tal?</p></body></html>', 'latin1');
  const target = await serve('127.0.0.1', (req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { location: '/middle?x=1' });
      res.end();
    } else if (req.url === '/middle?x=1') {
      res.writeHead(301, { location: `http://127.0.0.1:${target.port}/final` });
      res.end();
    } else {
      res.writeHead(200, { 'content-type': 'Text/HTML; Charset="ISO-8859-1"' });
      res.end(latin1);
    }
  });
  const page = await fetchGuarded(`${target.url}/start`, { allowAddress: onlyFirstLoopback });
  assert.equal(page.url, `${target.url}/final`);
  assert.deepEqual(page.redirects, [`${target.url}/middle?x=1`, `${target.url}/final`]);
  assert.equal(page.status, 200);
  assert.equal(page.contentType, 'text/html');
  assert.equal(page.bytes, latin1.length);
  assert.equal(page.text, '<html><head><title>Café</title></head><body><p>Niño, ¿qué tal?</p></body></html>');

  const sent = target.headers[0];
  assert.equal(sent?.['user-agent'], 'Shipcast (+https://github.com/yeyo11/shipcast)');
  assert.equal(sent?.accept, 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9');
  assert.equal(sent?.['accept-encoding'], 'gzip, deflate, br');
  assert.equal(sent?.cookie, undefined);
  assert.equal(sent?.authorization, undefined);
});

test('a charset is read from a <meta> when the content type names none', async () => {
  const body = Buffer.from('<html><head><meta charset="iso-8859-1"></head><body>Año</body></html>', 'latin1');
  const target = await serve('127.0.0.1', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  const page = await fetchGuarded(`${target.url}/`, { allowAddress: onlyFirstLoopback });
  assert.match(page.text, /Año/);
});

test('a gzip or brotli body is decoded', async () => {
  const text = '# Notes\n\nCompressed — ünïcode.\n'.repeat(50);
  for (const [encoding, compressed] of [
    ['gzip', zlib.gzipSync(text)],
    ['br', zlib.brotliCompressSync(text)],
    ['deflate', zlib.deflateSync(text)],
  ] as const) {
    const target = await serve('127.0.0.1', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'content-encoding': encoding });
      res.end(compressed);
    });
    const page = await fetchGuarded(`${target.url}/notes.md`, { allowAddress: onlyFirstLoopback });
    assert.equal(page.text, text, encoding);
    assert.equal(page.contentType, 'text/markdown');
    assert.equal(page.bytes, Buffer.byteLength(text));
    assert.deepEqual(page.redirects, []);
  }
});

// A self-signed certificate for pages.test, made once with openssl for this test and trusted by nobody
const SELF_SIGNED = {
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQguFmsIF8wEsEKFoFS
li4VuXrstdt2QNjU5VEbLMhXV6OhRANCAASa8d+NM8sKL/qp+Kxs2LBIqgRcZr0x
KkiFoLj2/Clm5WEvPc4oabyTPXqdTK+lN8sunkoRyRJ7VYddcPx7a6QR
-----END PRIVATE KEY-----
`,
  cert: `-----BEGIN CERTIFICATE-----
MIIBmDCCAT6gAwIBAgIUXmyZzi4V+9rOeuVN1dRUbZ6KgkIwCgYIKoZIzj0EAwIw
FTETMBEGA1UEAwwKcGFnZXMudGVzdDAgFw0yNjEwMzAwMzMyMzZaGA8yMTI2MTAw
NjAzMzIzNlowFTETMBEGA1UEAwwKcGFnZXMudGVzdDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABJrx340zywov+qn4rGzYsEiqBFxmvTEqSIWguPb8KWblYS89zihp
vJM9ep1Mr6U3yy6eShHJEntVh11w/HtrpBGjajBoMB0GA1UdDgQWBBT76OF+eN+Q
zXr+I0hyivJU5egS+zAfBgNVHSMEGDAWgBT76OF+eN+QzXr+I0hyivJU5egS+zAP
BgNVHRMBAf8EBTADAQH/MBUGA1UdEQQOMAyCCnBhZ2VzLnRlc3QwCgYIKoZIzj0E
AwIDSAAwRQIgIEg54To4yTivQjRPVYuRVZdBUuLUz3aMBu10q04m5c0CIQCbLOGZ
KCsM/gafmADkTmcNPO3MIqhqKvicrr2LismYag==
-----END CERTIFICATE-----
`,
};

test('https goes over the vetted connection, names the host for SNI, and refuses a certificate nobody trusts', async () => {
  const servernames: string[] = [];
  const requests: string[] = [];
  const server = https.createServer(
    {
      ...SELF_SIGNED,
      SNICallback: (servername, done) => {
        servernames.push(servername);
        done(null, tls.createSecureContext(SELF_SIGNED));
      },
    },
    (req, res) => {
      requests.push(req.url ?? '');
      html(res, '<p>secret</p>');
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as net.AddressInfo;
  const resolve = resolver({ 'pages.test': [{ address: '127.0.0.1', family: 4 }] });

  const error = await refused(fetchGuarded(`https://pages.test:${port}/`, { resolve, allowAddress: onlyFirstLoopback }), 'network');
  // The client's answer is general (see the last test): the TLS failure is in the cause chain, for the log
  const causes = (e: unknown): string => (e instanceof Error ? `${e.message} ${causes(e.cause)}` : '');
  assert.match(causes(error), /self-signed|certificate|could not connect/i);
  assert.deepEqual(resolve.calls, ['pages.test'], 'resolved once, then connected to the vetted address');
  assert.deepEqual(servernames, ['pages.test'], 'the certificate is checked against the hostname, not the IP');
  assert.deepEqual(requests, [], 'no request crosses an untrusted connection');
});

test("the caller's abort ends the fetch with its own reason", async () => {
  const target = await serve('127.0.0.1', () => {});
  const controller = new AbortController();
  const reason = new Error('the owner cancelled');
  setTimeout(() => controller.abort(reason), 50);
  await assert.rejects(fetchGuarded(`${target.url}/`, { allowAddress: onlyFirstLoopback, signal: controller.signal }), (error) => error === reason);
});

test('a refusal tells the client nothing of the network behind the name: the addresses are only in its cause, for the log', async () => {
  const target = await serve('127.0.0.1', (_req, res) => html(res, 'secret'));
  const causes = (error: unknown): string => (error instanceof Error ? `${error.message} ${causes(error.cause)}` : '');
  const resolve = resolver({ 'internal.test': [{ address: '10.20.30.40', family: 4 }] });
  const leading = await refused(fetchGuarded(`http://internal.test:${target.port}/`, { resolve, timeoutMs: 2000 }), 'address');
  assert.doesNotMatch(leading.message, /10\.20\.30\.40/);
  assert.match(causes(leading.cause), /10\.20\.30\.40/);
  const missing = await refused(fetchGuarded('http://nowhere.test/', { resolve, timeoutMs: 2000 }), 'network');
  assert.doesNotMatch(missing.message, /no such host/);
  assert.match(causes(missing.cause), /no such host nowhere\.test/);
  // The vetted address passes, the socket reaches another: what it reached stays out of the answer too
  const swapped = await refused(fetchGuarded(`http://127.0.0.1:${target.port}/`, { resolve, timeoutMs: 2000, allowAddress: () => false }), 'address');
  assert.doesNotMatch(swapped.message, /127\.0\.0\.1 (is|leads|connected)/);
});
