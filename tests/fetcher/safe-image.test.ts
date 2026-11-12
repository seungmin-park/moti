import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { strictFetchPolicy } from "../../src/features/metadata/infrastructure/address-policy";
import { createSafeImageSource, type Resolve } from "../../src/features/metadata/infrastructure/safe-fetch";
import { loopbackPolicy } from "../support/fetch-policy";

const MiB = 1024 * 1024;
// Bytes that are not valid UTF-8 and would change if anything decoded them as text.
const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0xc3, 0x28, 0x00, 0x80, 0xed, 0xa0, 0x80]);

let server: Server;
let port: number;
let base: string;
let seen: { path: string; headers: IncomingHttpHeaders }[] = [];

function image(res: ServerResponse, body: Buffer, headers: Record<string, string> = { "content-type": "image/png" }) {
  res.writeHead(200, headers);
  res.end(body);
}

function endless(res: ServerResponse, chunk: Buffer, delayMs: number) {
  const write = () => {
    if (res.destroyed || res.writableEnded) return;
    res.write(chunk);
    setTimeout(write, delayMs);
  };
  write();
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://local.test");
    seen.push({ path: url.pathname, headers: req.headers });
    req.socket.on("error", () => {});
    switch (url.pathname) {
      case "/png":
        return image(res, picture);
      case "/octet":
        return image(res, picture, { "content-type": "application/octet-stream" });
      case "/binary":
        return image(res, picture, { "content-type": "binary/octet-stream" });
      case "/untyped":
        return image(res, picture, {});
      case "/three-mib":
        return image(res, Buffer.alloc(3 * MiB, 7), { "content-type": "image/jpeg" });
      case "/html":
        return image(res, Buffer.from("<html></html>"), { "content-type": "text/html" });
      case "/svg":
        return image(res, Buffer.from("<svg/>"), { "content-type": "image/svg+xml; charset=utf-8" });
      case "/declared-large":
        res.writeHead(200, { "content-type": "image/png", "content-length": String(9 * MiB) });
        return res.write(picture);
      case "/endless":
        res.writeHead(200, { "content-type": "image/png" });
        return endless(res, Buffer.alloc(256 * 1024, 1), 0);
      case "/gzip-bomb":
        return image(res, gzipSync(Buffer.alloc(20 * MiB)), { "content-type": "image/png", "content-encoding": "gzip" });
      case "/trickle":
        res.writeHead(200, { "content-type": "image/png" });
        return endless(res, Buffer.from([1]), 50);
      case "/to":
        res.writeHead(302, { location: url.searchParams.get("location")! });
        return res.end();
      default: {
        const status = Number(url.pathname.slice(1));
        res.writeHead(Number.isInteger(status) && status >= 300 ? status : 404, { "content-type": "text/html" });
        return res.end("<html>error</html>");
      }
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
});

const resolveLocal: Resolve = async (host) => {
  if (host === "shop.test") return [{ address: "127.0.0.1", family: 4 }];
  if (host === "internal.test") return [{ address: "10.0.0.1", family: 4 }];
  throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
};
const pageUrl = "https://shop.test/products/42?ref=owner-mail&token=secret#reviews";
const source = (limits = {}) => createSafeImageSource({ policy: loopbackPolicy(port), resolve: resolveLocal, limits });
const read = (path: string, options: { signal?: AbortSignal; limits?: object } = {}) =>
  source(options.limits).read(path.startsWith("http") ? path : `${base}${path}`,
    { pageUrl, signal: options.signal ?? new AbortController().signal });

describe("안전한 사진 요청", () => {
  it("Given 사진 응답 When 읽으면 Then 바이트를 그대로 돌려준다", async () => {
    const result = await read("/png");
    expect(result.ok).toBe(true);
    expect(Buffer.from((result as { bytes: Uint8Array }).bytes).equals(picture)).toBe(true);
  });

  it.each(["/octet", "/binary", "/untyped"])("Given 형식을 밝히지 않은 %s When 읽으면 Then 바이트로 받고 판단은 뒤로 미룬다", async (path) => {
    expect(await read(path)).toMatchObject({ ok: true });
  });

  it("Given 페이지 한도보다 큰 3 MiB 사진 When 읽으면 Then 사진 한도 안이라 받는다", async () => {
    const result = await read("/three-mib");
    expect(result.ok && result.bytes.byteLength).toBe(3 * MiB);
  });

  it.each(["/html", "/svg"])("Given %s 응답 When 읽으면 Then 지원하지 않는 형식이다", async (path) => {
    expect(await read(path)).toEqual({ ok: false, code: "unsupported_content" });
  });

  it.each(["/declared-large", "/endless", "/gzip-bomb"])("Given 8 MiB를 넘는 %s When 읽으면 Then 너무 크다", async (path) => {
    expect(await read(path)).toEqual({ ok: false, code: "too_large" });
  });

  it("Given 사설 주소로 이동 When 읽으면 Then 연결하지 않고 막는다", async () => {
    expect(await read(`/to?location=${encodeURIComponent(`http://internal.test:${port}/png`)}`)).toEqual({ ok: false, code: "blocked_address" });
    expect(seen.map((request) => request.path)).toEqual(["/to"]);
  });

  it("Given 운영 정책 When 로컬 서버의 사진을 읽으면 Then 루프백이라 막는다", async () => {
    const strict = createSafeImageSource({ policy: strictFetchPolicy, resolve: resolveLocal });
    expect(await strict.read(`${base}/png`, { pageUrl, signal: new AbortController().signal })).toEqual({ ok: false, code: "blocked_address" });
    expect(seen).toEqual([]);
  });

  it("Given 상품 페이지 주소 When 사진을 요청하면 Then 출처만 Referer로 보내고 쿠키·인증 없이 사진을 요청한다", async () => {
    await read(`http://shop.test:${port}/png`);
    expect(seen).toHaveLength(1);
    const { headers } = seen[0];
    expect(headers.referer).toBe("https://shop.test/");
    expect(headers.accept).toBe("image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1");
    expect(headers.cookie).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers["user-agent"]).toBe("Mozilla/5.0 (compatible; moti/0.1; +https://github.com/seungmin-park/moti)");
  });

  it("Given 호출한 쪽이 기다림을 그만둠 When 느린 사진을 읽으면 Then 바로 시간 초과다", async () => {
    const started = Date.now();
    expect(await read("/trickle", { signal: AbortSignal.timeout(200) })).toEqual({ ok: false, code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("Given 전체 시간 한도 When 느린 사진을 읽으면 Then 시간 초과다", async () => {
    expect(await read("/trickle", { limits: { totalMs: 300 } })).toEqual({ ok: false, code: "timeout" });
  });

  it.each([[403, "blocked_by_site"], [404, "http_status"]])("Given %d 응답 When 읽으면 Then %s다", async (status, code) => {
    expect(await read(`/${status}`)).toEqual({ ok: false, code });
  });
});
