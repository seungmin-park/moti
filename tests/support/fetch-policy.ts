import type { FetchPolicy } from "../../src/features/metadata/infrastructure/address-policy";

// Only for tests that serve pages from this machine: loopback 127.0.0.1 on the listed ports and nothing else.
export function loopbackPolicy(...ports: number[]): FetchPolicy {
  return { ports: new Set(ports), blocks: (address) => address !== "127.0.0.1" };
}
