import type { LookupAddress, LookupOneOptions } from "node:dns";
import { lookup as systemLookup } from "node:dns/promises";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { PageRead, PageSource } from "../application/collection";
import type { CollectionErrorCode } from "../domain/collection-error";
import { toFetchTarget, type FetchPolicy, type FetchTarget } from "./address-policy";

export type FetchLimits = {
  connectMs: number;
  totalMs: number;
  maxEncodedBytes: number;
  maxDecodedBytes: number;
  maxRedirects: number;
};
export type ResolvedAddress = { address: string; family: number };
export type Resolve = (host: string) => Promise<ResolvedAddress[]>;

const MiB = 1024 * 1024;
const defaultLimits: FetchLimits = {
  connectMs: 5_000,
  totalMs: 15_000,
  maxEncodedBytes: 2 * MiB,
  maxDecodedBytes: 4 * MiB,
  maxRedirects: 5,
};
const redirects = new Set([301, 302, 303, 307, 308]);
const refusals = new Set([401, 403, 429, 451]);
const htmlTypes = new Set(["text/html", "application/xhtml+xml"]);
const decoders: Record<string, (() => Transform) | null> = {
  identity: null,
  gzip: createGunzip,
  "x-gzip": createGunzip,
  deflate: createInflate,
  br: createBrotliDecompress,
};
const dnsErrors = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_NONAME", "EAI_FAIL", "EAI_NODATA", "ENODATA"]);
const headers = {
  "user-agent": "Mozilla/5.0 (compatible; moti/0.1; +https://github.com/seungmin-park/moti)",
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
  "accept-language": "ko-KR,ko;q=0.9,en;q=0.5",
  "accept-encoding": "gzip, deflate, br",
};

class FetchFailure extends Error {
  readonly code: CollectionErrorCode;

  constructor(code: CollectionErrorCode) {
    super(code);
    this.code = code;
  }
}

const systemResolve: Resolve = (host) => systemLookup(host, { all: true, verbatim: true });

function classify(error: unknown, signal: AbortSignal): CollectionErrorCode {
  if (error instanceof FetchFailure) return error.code;
  if (signal.aborted) return "timeout";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && dnsErrors.has(code) ? "dns_failed" : "connect_failed";
}

function charsetOf(contentType: string | undefined, bytes: Buffer): string {
  const declared = /charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? "")?.[1] ??
    /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i.exec(bytes.subarray(0, 1024).toString("latin1"))?.[1];
  return declared ?? "utf-8";
}

function decodeText(bytes: Buffer, contentType: string | undefined): string {
  try {
    return new TextDecoder(charsetOf(contentType, bytes)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export function createSafePageSource({ policy, resolve = systemResolve, limits: overrides = {} }: {
  policy: FetchPolicy;
  resolve?: Resolve;
  limits?: Partial<FetchLimits>;
}): PageSource {
  const limits = { ...defaultLimits, ...overrides };

  // Answers Node's lookup with addresses that already passed the policy, so the socket connects to exactly
  // what was checked; a resolver that changes its answer later cannot slip a private address in.
  function pinnedLookup(hostname: string, options: LookupOneOptions & { all?: boolean },
    callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void) {
    resolve(hostname).then((addresses) => {
      if (addresses.length === 0) throw Object.assign(new Error(`no address for ${hostname}`), { code: "ENOTFOUND" });
      if (addresses.some(({ address }) => policy.blocks(address))) throw new FetchFailure("blocked_address");
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }).catch((error: Error) => callback(error, ""));
  }

  function request(url: URL, target: FetchTarget & { ok: true }, signal: AbortSignal): Promise<IncomingMessage> {
    const secure = url.protocol === "https:";
    const options: RequestOptions = {
      host: target.address ?? target.host,
      port: target.port,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers,
      // A fresh agent per hop: no pooled socket from an earlier hop and no proxy taken from the environment.
      agent: secure ? new HttpsAgent({ keepAlive: false }) : new HttpAgent({ keepAlive: false }),
      lookup: pinnedLookup as RequestOptions["lookup"],
      signal,
      // SNI carries names only; an IP literal is checked against the certificate without it.
      ...(secure && target.address === null && { servername: target.host }),
    };
    return new Promise((settle, reject) => {
      const outgoing = (secure ? httpsRequest : httpRequest)(options);
      outgoing.on("socket", (socket: Socket) => {
        const timer = setTimeout(() => outgoing.destroy(new FetchFailure("timeout")), limits.connectMs);
        socket.once("close", () => clearTimeout(timer));
        socket.once("connect", () => {
          clearTimeout(timer);
          if (!socket.remoteAddress || policy.blocks(socket.remoteAddress)) {
            outgoing.destroy(new FetchFailure("blocked_address"));
          }
        });
      });
      outgoing.once("response", settle);
      outgoing.on("error", reject);
      outgoing.end();
    });
  }

  async function body(response: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
    const encoding = (response.headers["content-encoding"] ?? "identity").trim().toLowerCase() || "identity";
    if (!Object.hasOwn(decoders, encoding)) throw new FetchFailure("unsupported_content");
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limits.maxEncodedBytes) throw new FetchFailure("too_large");

    let encoded = 0;
    let decoded = 0;
    const chunks: Buffer[] = [];
    async function* counted(source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        encoded += chunk.byteLength;
        if (encoded > limits.maxEncodedBytes) throw new FetchFailure("too_large");
        yield chunk;
      }
    }
    async function collect(source: AsyncIterable<unknown>) {
      for await (const chunk of source as AsyncIterable<Buffer>) {
        decoded += chunk.byteLength;
        if (decoded > limits.maxDecodedBytes) throw new FetchFailure("too_large");
        chunks.push(chunk);
      }
    }
    const decoder = decoders[encoding];
    try {
      if (decoder) await pipeline(response, counted, decoder(), collect, { signal });
      else await pipeline(response, counted, collect, { signal });
    } catch (error) {
      if (error instanceof FetchFailure || signal.aborted) throw error;
      const code = (error as { code?: unknown }).code;
      if (decoder && typeof code === "string" && /^(Z_|ERR_BROTLI|ERR__ZLIB)/.test(code)) throw new FetchFailure("decode_failed");
      throw error;
    }
    return Buffer.concat(chunks);
  }

  return {
    async read(address: string): Promise<PageRead> {
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), limits.totalMs);
      let status: number | null = null;
      try {
        let url: URL;
        try {
          url = new URL(address);
        } catch {
          return { ok: false, code: "invalid_url", status };
        }
        for (let hops = 0; ; hops += 1) {
          const target = toFetchTarget(url, policy);
          if (!target.ok) return { ok: false, code: target.code, status };
          const response = await request(url, target, deadline.signal);
          status = response.statusCode ?? 0;
          const location = response.headers.location;
          if (redirects.has(status) && location) {
            response.destroy();
            if (hops >= limits.maxRedirects) return { ok: false, code: "too_many_redirects", status };
            try {
              url = new URL(location, url);
            } catch {
              return { ok: false, code: "invalid_url", status };
            }
            continue;
          }
          if (status < 200 || status >= 300) {
            response.destroy();
            return { ok: false, code: refusals.has(status) ? "blocked_by_site" : "http_status", status };
          }
          const contentType = response.headers["content-type"];
          if (!htmlTypes.has(contentType?.split(";")[0].trim().toLowerCase() ?? "")) {
            response.destroy();
            return { ok: false, code: "unsupported_content", status };
          }
          try {
            const bytes = await body(response, deadline.signal);
            return { ok: true, page: { html: decodeText(bytes, contentType), url: url.href, status } };
          } finally {
            response.destroy();
          }
        }
      } catch (error) {
        return { ok: false, code: classify(error, deadline.signal), status };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
