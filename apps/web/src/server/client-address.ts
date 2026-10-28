import { BlockList, isIP } from 'node:net';

/*
 * The client a request comes from, for the API's limit on wrong tokens. Behind Traefik every socket
 * is the proxy's, so all clients would share one count; the proxy says who the client was in
 * X-Forwarded-For, but anyone can send that header. It is believed only when the socket's peer is a
 * proxy the deployment named (SHIPCAST_TRUSTED_PROXIES: addresses or CIDR ranges), and then read
 * from the right, past every trusted hop: the first address no trusted proxy added is the client.
 */

const unmapped = (address: string) => address.trim().replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '');

/** The trusted proxies of SHIPCAST_TRUSTED_PROXIES; undefined when none is named (the socket is the client, as before) */
export function parseTrustedProxies(value: string | undefined): BlockList | undefined {
  const entries = (value ?? '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length === 0) return undefined;
  const list = new BlockList();
  for (const entry of entries) {
    const [address = '', bits] = entry.split('/');
    const family = isIP(address);
    if (family === 0) throw new Error(`SHIPCAST_TRUSTED_PROXIES: "${entry}" is not an address or a CIDR range`);
    const type = family === 4 ? 'ipv4' : 'ipv6';
    if (bits === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(bits), type);
  }
  return list;
}

const trusted = (list: BlockList, address: string) => {
  const family = isIP(address);
  return family !== 0 && list.check(address, family === 4 ? 'ipv4' : 'ipv6');
};

export function clientAddress(peer: string | undefined, forwardedFor: string | undefined | null, proxies: BlockList | undefined): string {
  const socket = peer ? unmapped(peer) : 'unknown';
  if (!proxies || !trusted(proxies, socket) || !forwardedFor) return socket;
  const hops = forwardedFor.split(',').map(unmapped).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i]!;
    // A hop that is not an address was written by someone the proxy did not vouch for
    if (isIP(hop) === 0) return hops[i + 1] ?? socket;
    if (!trusted(proxies, hop)) return hop;
  }
  return hops[0] ?? socket;
}
