import { BlockList, isIP } from "node:net";

export type FetchPolicy = {
  readonly ports: ReadonlySet<number>;
  blocks(address: string): boolean;
};

export type FetchTarget =
  | { ok: true; host: string; port: number; address: string | null }
  | { ok: false; code: "invalid_url" | "blocked_address" };

const blockedV4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blockedV4.addSubnet(network, prefix, "ipv4");

// IPv6 is an allowlist: only global unicast, so NAT64, ULA, link-local and mapped forms stay out by default.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [network, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blockedV6.addSubnet(network, prefix, "ipv6");
}

function mappedV4(address: string): string | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blockedV4.check(address, "ipv4");
  if (family !== 6) return true;
  const v4 = mappedV4(address);
  if (v4 !== null) return isIP(v4) !== 4 || blockedV4.check(v4, "ipv4");
  return !globalV6.check(address, "ipv6") || blockedV6.check(address, "ipv6");
}

export const strictFetchPolicy: FetchPolicy = { ports: new Set([80, 443]), blocks: isBlockedAddress };

export function toFetchTarget(url: URL, policy: FetchPolicy): FetchTarget {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname) {
    return { ok: false, code: "invalid_url" };
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  // URL keeps IPv6 literals in brackets and has already normalised forms like 2130706433 to dotted IPv4.
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const literal = isIP(host) !== 0;
  if (!policy.ports.has(port) || (literal && policy.blocks(host))) return { ok: false, code: "blocked_address" };
  return { ok: true, host, port, address: literal ? host : null };
}
