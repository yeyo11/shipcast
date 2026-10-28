import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clientAddress, parseTrustedProxies } from '../src/server/client-address.ts';

test('without trusted proxies the socket is the client, whatever the headers say', () => {
  assert.equal(clientAddress('203.0.113.7', '198.51.100.1', undefined), '203.0.113.7');
  assert.equal(clientAddress('::ffff:203.0.113.7', null, undefined), '203.0.113.7');
  assert.equal(parseTrustedProxies(''), undefined);
});

test('behind a trusted proxy the client is the first address no trusted hop added', () => {
  const proxies = parseTrustedProxies('10.0.0.0/8, 172.18.0.2');
  assert.equal(clientAddress('172.18.0.2', '198.51.100.1', proxies), '198.51.100.1');
  // A client that sends its own X-Forwarded-For only adds to the left of what the proxy appends
  assert.equal(clientAddress('172.18.0.2', '1.2.3.4, 198.51.100.1', proxies), '198.51.100.1');
  assert.equal(clientAddress('172.18.0.2', '198.51.100.1, 10.1.2.3', proxies), '198.51.100.1', 'past every trusted hop');
  assert.equal(clientAddress('::ffff:172.18.0.2', '198.51.100.1', proxies), '198.51.100.1');
});

test('a peer that is not a trusted proxy cannot pick its own address', () => {
  const proxies = parseTrustedProxies('172.18.0.2');
  assert.equal(clientAddress('203.0.113.7', '127.0.0.1', proxies), '203.0.113.7');
  assert.equal(clientAddress('172.18.0.2', 'not-an-ip, 198.51.100.1', proxies), '198.51.100.1');
  assert.equal(clientAddress('172.18.0.2', undefined, proxies), '172.18.0.2');
  assert.throws(() => parseTrustedProxies('traefik'), /SHIPCAST_TRUSTED_PROXIES/);
});
