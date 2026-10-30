import { isIPv4, isIPv6 } from 'node:net';

/** An IPv4 range as its first address (a 32-bit number) and its prefix length */
type Range4 = readonly [base: number, prefix: number];

function v4(text: string): number {
  const [a = 0, b = 0, c = 0, d = 0] = text.split('.').map(Number);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

// Every IPv4 block IANA marks as not globally reachable, or reserved: the server that fetches a
// source also hosts the database, Redis, other stacks and a tailnet (100.64/10), and sits on a cloud
// with a metadata service (169.254.169.254), all of which these cover
const BLOCKED_V4: readonly Range4[] = [
  [v4('0.0.0.0'), 8],
  [v4('10.0.0.0'), 8],
  [v4('100.64.0.0'), 10],
  [v4('127.0.0.0'), 8],
  [v4('169.254.0.0'), 16],
  [v4('172.16.0.0'), 12],
  [v4('192.0.0.0'), 24],
  [v4('192.0.2.0'), 24],
  [v4('192.88.99.0'), 24],
  [v4('192.168.0.0'), 16],
  [v4('198.18.0.0'), 15],
  [v4('198.51.100.0'), 24],
  [v4('203.0.113.0'), 24],
  [v4('224.0.0.0'), 4],
  // 240/4 also holds 255.255.255.255, the limited broadcast
  [v4('240.0.0.0'), 4],
];

function inRange4(address: number, [base, prefix]: Range4): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) >>> 0 === base;
}

function isPublic4(address: number): boolean {
  return !BLOCKED_V4.some((range) => inRange4(address, range));
}

/** The eight 16-bit groups of a valid IPv6 literal (one `net.isIPv6` accepted, without a zone) */
function groups6(text: string): number[] {
  let body = text;
  let tail: number[] = [];
  // A dotted IPv4 tail (::ffff:1.2.3.4, ::1.2.3.4, 64:ff9b::1.2.3.4) is two groups
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(body);
  if (dotted?.[1]) {
    const n = v4(dotted[1]);
    tail = [n >>> 16, n & 0xffff];
    body = body.slice(0, -dotted[1].length);
    // `::1.2.3.4` leaves `::`, `::ffff:1.2.3.4` leaves `::ffff:`: drop the separator, not a `::`
    if (body.endsWith(':') && !body.endsWith('::')) body = body.slice(0, -1);
  }
  const parse = (part: string): number[] => (part === '' ? [] : part.split(':').map((g) => Number.parseInt(g, 16)));
  const gap = body.indexOf('::');
  let head: number[];
  if (gap === -1) {
    head = parse(body);
  } else {
    const left = parse(body.slice(0, gap));
    const right = parse(body.slice(gap + 2));
    const zeros = 8 - tail.length - left.length - right.length;
    head = [...left, ...new Array<number>(Math.max(zeros, 0)).fill(0), ...right];
  }
  return [...head, ...tail];
}

function embedded4(g: readonly number[]): number {
  return (((g[6] ?? 0) << 16) | (g[7] ?? 0)) >>> 0;
}

function startsWith(g: readonly number[], prefix: readonly number[]): boolean {
  return prefix.every((value, i) => g[i] === value);
}

function isPublic6(g: readonly number[]): boolean {
  const [g0 = 0, g1 = 0] = g;
  // The forms that carry an IPv4 address are as reachable as that address: IPv4-compatible
  // (::a.b.c.d, which also covers :: and ::1), IPv4-mapped (::ffff:a.b.c.d), IPv4-translated
  // (::ffff:0:a.b.c.d) and the well-known NAT64 prefix (64:ff9b::/96). A dual-stack socket connecting
  // to ::ffff:127.0.0.1 reaches the loopback, so the embedded address is what is judged
  if (startsWith(g, [0, 0, 0, 0, 0, 0])) return isPublic4(embedded4(g));
  if (startsWith(g, [0, 0, 0, 0, 0, 0xffff])) return isPublic4(embedded4(g));
  if (startsWith(g, [0, 0, 0, 0, 0xffff, 0])) return isPublic4(embedded4(g));
  if (startsWith(g, [0x64, 0xff9b, 0, 0, 0, 0])) return isPublic4(embedded4(g));
  // 64:ff9b:1::/48 is the local-use translation prefix (RFC 8215): it only means something inside
  // one operator's network, so it is never a public destination whatever it embeds
  if (g0 === 0x64 && g1 === 0xff9b && g[2] === 1) return false;
  // 6to4 (2002::/16) carries the IPv4 address of its relay in groups 1 and 2
  if (g0 === 0x2002) return isPublic4(((g1 << 16) | (g[2] ?? 0)) >>> 0);
  // Only 2000::/3 is allocated global unicast: this one test refuses ::/8 leftovers, 100::/64
  // (discard), fc00::/7 (unique local), fe80::/10 (link-local), fec0::/10 (site-local) and ff00::/8
  // (multicast), and anything IANA has not allocated yet
  if ((g0 & 0xe000) !== 0x2000) return false;
  // 2001::/23, IETF protocol assignments, Teredo (2001::/32) among them
  if (g0 === 0x2001 && g1 < 0x0200) return false;
  // 2001:db8::/32 and 3fff::/20, documentation
  if (g0 === 0x2001 && g1 === 0x0db8) return false;
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return false;
  return true;
}

/**
 * Whether an IP address is one a fetch may connect to: globally routable, not a private, loopback,
 * link-local, shared (CGNAT), documentation, multicast or reserved one, in IPv4 or IPv6, including the
 * IPv6 forms that embed an IPv4 address. Anything that is not an IP literal is refused, and so is an
 * address with a zone id (`fe80::1%eth0`): a zone only exists for link-local destinations. A bracketed
 * IPv6 literal (`[::1]`, as URLs write it) is read without its brackets.
 */
export function isPublicAddress(ip: string): boolean {
  if (ip.includes('%')) return false;
  // Brackets only ever wrap an IPv6 literal: `[1.2.3.4]` is not an address
  const bracketed = ip.startsWith('[') && ip.endsWith(']');
  const text = bracketed ? ip.slice(1, -1) : ip;
  if (!bracketed && isIPv4(text)) return isPublic4(v4(text));
  if (isIPv6(text)) {
    const g = groups6(text.toLowerCase());
    return g.length === 8 && isPublic6(g);
  }
  return false;
}
