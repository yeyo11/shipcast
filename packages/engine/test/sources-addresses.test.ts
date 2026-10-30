import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPublicAddress } from '../src/sources/addresses.ts';

const ALLOWED = [
  '1.1.1.1',
  '8.8.8.8',
  '93.184.216.34',
  '100.63.255.255', // just below the CGNAT block
  '100.128.0.0', // just above it
  '172.15.255.255',
  '172.32.0.0',
  '192.0.1.1',
  '198.17.255.255',
  '198.20.0.0',
  '223.255.255.255',
  '2606:4700:4700::1111',
  '2001:4860:4860::8888',
  '2a00:1450:4001:80b::200e',
  '[2606:4700:4700::1111]',
  '::ffff:8.8.8.8', // mapped, public inside
  '::ffff:808:808',
  '64:ff9b::8.8.8.8', // NAT64 of a public address
  '2002:0808:0808::1', // 6to4 through a public relay
];

const REFUSED = [
  // IPv4
  '0.0.0.0',
  '0.1.2.3',
  '10.0.0.1',
  '10.255.255.255',
  '100.64.0.1',
  '100.100.100.100',
  '100.127.255.255',
  '127.0.0.1',
  '127.255.255.254',
  '169.254.169.254',
  '169.254.0.1',
  '172.16.0.1',
  '172.31.255.255',
  '192.0.0.1',
  '192.0.0.170',
  '192.0.2.1',
  '192.88.99.1',
  '192.168.0.1',
  '192.168.255.255',
  '198.18.0.1',
  '198.19.255.255',
  '198.51.100.7',
  '203.0.113.9',
  '224.0.0.1',
  '239.255.255.250',
  '240.0.0.1',
  '255.255.255.255',
  // IPv6
  '::',
  '::1',
  '0:0:0:0:0:0:0:1',
  '[::1]',
  'fc00::1',
  'fd12:3456:789a::1',
  'fe80::1',
  'fe80::1%eth0',
  '[fe80::1%25eth0]',
  'febf::1',
  'fec0::1',
  'ff02::1',
  'ff05::1:3',
  '2001:db8::1',
  '2001:db8:ffff::1',
  '100::1',
  '100::ffff:ffff:ffff:ffff',
  '2001::1', // Teredo
  '2001:0:4136:e378:8000:63bf:3fff:fdd2',
  '2001:2::1', // benchmarking, in 2001::/23
  '2001:1ff::1',
  '3fff::1', // documentation (RFC 9637)
  // IPv6 forms that embed a private IPv4 address
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
  '::FFFF:7F00:0001',
  '::ffff:10.0.0.1',
  '::ffff:169.254.169.254',
  '::ffff:a9fe:a9fe',
  '::ffff:100.64.0.1',
  '::ffff:0:127.0.0.1',
  '::127.0.0.1',
  '::10.0.0.1',
  '::a00:1',
  '64:ff9b::127.0.0.1',
  '64:ff9b::a00:1',
  '64:ff9b::192.168.1.1',
  '64:ff9b:1::8.8.8.8', // local-use NAT64 is never public
  '64:ff9b:1:ffff::1',
  '2002:7f00:0001::1',
  '2002:0a00:0001::1',
  '2002:c0a8:0101::1',
  // Not IP literals at all
  '',
  ' ',
  'localhost',
  'example.com',
  '1.1.1',
  '1.1.1.1.1',
  '256.1.1.1',
  '01.1.1.1',
  '0x7f.0.0.1',
  '2130706433',
  '1.1.1.1 ',
  ' 1.1.1.1',
  '::g',
  '1::2::3',
  '[1.1.1.1]',
  'http://1.1.1.1/',
];

test('public addresses are allowed', () => {
  for (const ip of ALLOWED) assert.equal(isPublicAddress(ip), true, ip);
});

test('every special-purpose range, embedded IPv4 form and non-literal is refused', () => {
  for (const ip of REFUSED) assert.equal(isPublicAddress(ip), false, JSON.stringify(ip));
});
