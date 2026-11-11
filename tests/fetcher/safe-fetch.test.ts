import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { strictFetchPolicy } from "../../src/features/metadata/infrastructure/address-policy";
import { createSafePageSource, type Resolve } from "../../src/features/metadata/infrastructure/safe-fetch";
import { loopbackPolicy } from "../support/fetch-policy";

const MiB = 1024 * 1024;
const html = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body></body></html>`;

let server: Server;
let port: number;
let closedPort: number;
let base: string;
let seen: { path: string; headers: IncomingHttpHeaders }[] = [];

function page(res: ServerResponse, body: string | Buffer, headers: Record<string, string> = {}) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...headers });
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
    const hop = /^\/hop\/(\d+)$/.exec(url.pathname);
    if (hop) {
      const left = Number(hop[1]);
      if (left === 0) return page(res, html("도착"));
      res.writeHead(302, { location: `/hop/${left - 1}` });
      return res.end();
    }
    switch (url.pathname) {
      case "/ok":
        return page(res, html("램프"));
      case "/to":
        res.writeHead(307, { location: url.searchParams.get("location")! });
        return res.end();
      case "/declared-large":
        res.writeHead(200, { "content-type": "text/html", "content-length": String(3 * MiB) });
        return res.write("<html>");
      case "/endless":
        res.writeHead(200, { "content-type": "text/html" });
        return endless(res, Buffer.alloc(64 * 1024, "a"), 0);
      case "/gzip-bomb":
        return page(res, gzipSync(Buffer.alloc(10 * MiB, " ")), { "content-encoding": "gzip" });
      case "/corrupt-gzip":
        return page(res, Buffer.from("this is not gzip at all"), { "content-encoding": "gzip" });
      case "/brotli":
        return page(res, brotliCompressSync(Buffer.from(html("압축한 페이지"))), { "content-encoding": "br" });
      case "/compress":
        return page(res, html("x"), { "content-encoding": "compress" });
      case "/trickle":
        res.writeHead(200, { "content-type": "text/html" });
        return endless(res, Buffer.from("a"), 50);
      case "/png":
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      case "/euc-kr":
        // "가방" in EUC-KR, declared only by the document's meta tag.
        return page(res, Buffer.concat([
          Buffer.from('<html><head><meta charset="euc-kr"><title>'),
          Buffer.from([0xb0, 0xa1, 0xb9, 0xe6]),
          Buffer.from("</title></head></html>"),
        ]), { "content-type": "text/html" });
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
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  closedPort = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
});

const answers: Record<string, string[][]> = {
  "local.test": [["127.0.0.1"]],
  "internal.test": [["10.0.0.1"]],
  "mixed.test": [["127.0.0.1", "10.0.0.1"]],
  "rebind.test": [["127.0.0.1"], ["127.0.0.2"]],
};

// Stands in for DNS: each name answers in turn from its list, which is how a rebinding resolver behaves.
function fakeResolver(): Resolve {
  const calls = new Map<string, number>();
  return async (host) => {
    const sequence = answers[host];
    if (!sequence) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    const call = calls.get(host) ?? 0;
    calls.set(host, call + 1);
    return sequence[Math.min(call, sequence.length - 1)].map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

const source = (limits = {}) => createSafePageSource({ policy: loopbackPolicy(port, closedPort), resolve: fakeResolver(), limits });
const read = (path: string, limits = {}) => source(limits).read(path.startsWith("http") ? path : `${base}${path}`);
const redirectTo = (location: string) => `/to?location=${encodeURIComponent(location)}`;

describe("안전한 페이지 요청", () => {
  it("Given 허용한 주소의 HTML When 읽으면 Then 본문, 최종 주소와 상태를 돌려준다", async () => {
    const result = await read(`http://local.test:${port}/ok`);
    expect(result).toEqual({ ok: true, page: { html: html("램프"), url: `http://local.test:${port}/ok`, status: 200 } });
  });

  it("Given 다섯 번의 이동 When 읽으면 Then 마지막 페이지를 읽고, 여섯 번이면 이동 초과다", async () => {
    const five = await read("/hop/5");
    expect(five).toMatchObject({ ok: true, page: { url: `${base}/hop/0`, html: html("도착") } });
    expect(await read("/hop/6")).toEqual({ ok: false, code: "too_many_redirects", status: 302 });
    expect(seen.filter((request) => request.path === "/hop/0")).toHaveLength(1);
  });

  it.each([
    ["IPv6 루프백", () => `http://[::1]:${port}/ok`],
    ["클라우드 메타데이터", () => `http://169.254.169.254:${port}/ok`],
    ["사설 주소로 풀리는 이름", () => `http://internal.test:${port}/ok`],
    ["사설과 공인 주소가 섞인 이름", () => `http://mixed.test:${port}/ok`],
    ["허용하지 않은 포트", () => "http://127.0.0.1:1/ok"],
  ])("Given %s로 이동 When 읽으면 Then 연결하지 않고 막는다", async (_, location) => {
    expect(await read(redirectTo(location()))).toEqual({ ok: false, code: "blocked_address", status: 307 });
    expect(seen.map((request) => request.path)).toEqual(["/to"]);
  });

  it("Given 사설과 공인 주소가 섞인 이름 When 바로 읽으면 Then 막는다", async () => {
    expect(await read(`http://mixed.test:${port}/ok`)).toEqual({ ok: false, code: "blocked_address", status: null });
    expect(seen).toEqual([]);
  });

  it("Given 운영 정책 When 로컬 테스트 서버를 읽으면 Then 루프백이라 막는다", async () => {
    const strict = createSafePageSource({ policy: strictFetchPolicy, resolve: fakeResolver() });
    expect(await strict.read(`${base}/ok`)).toEqual({ ok: false, code: "blocked_address", status: null });
    expect(await strict.read("http://127.0.0.1/ok")).toEqual({ ok: false, code: "blocked_address", status: null });
    expect(await strict.read("http://2130706433/ok")).toEqual({ ok: false, code: "blocked_address", status: null });
    expect(seen).toEqual([]);
  });

  it("Given 첫 확인 뒤 다른 주소를 돌려주는 DNS When 이동 단계에서 다시 풀면 Then 바뀐 주소를 막는다", async () => {
    const result = await read(`http://rebind.test:${port}${redirectTo(`http://rebind.test:${port}/ok`)}`);
    expect(result).toEqual({ ok: false, code: "blocked_address", status: 307 });
    expect(seen.map((request) => request.path)).toEqual(["/to"]);
  });

  it("Given 3 MiB라고 밝힌 응답 When 읽으면 Then 본문을 받기 전에 너무 크다", async () => {
    expect(await read("/declared-large")).toEqual({ ok: false, code: "too_large", status: 200 });
  });

  it("Given 끝없는 chunked 응답 When 읽으면 Then 2 MiB에서 멈춘다", async () => {
    expect(await read("/endless")).toEqual({ ok: false, code: "too_large", status: 200 });
  });

  it("Given 압축을 풀면 10 MiB인 gzip When 읽으면 Then 푼 크기 한도에서 멈춘다", async () => {
    expect(await read("/gzip-bomb")).toEqual({ ok: false, code: "too_large", status: 200 });
  });

  it("Given 깨진 gzip When 읽으면 Then 해독 실패다", async () => {
    expect(await read("/corrupt-gzip")).toEqual({ ok: false, code: "decode_failed", status: 200 });
  });

  it("Given brotli 압축 When 읽으면 Then 풀어서 읽는다", async () => {
    expect(await read("/brotli")).toMatchObject({ ok: true, page: { html: html("압축한 페이지") } });
  });

  it("Given 지원하지 않는 압축 방식 When 읽으면 Then 지원하지 않는 형식이다", async () => {
    expect(await read("/compress")).toEqual({ ok: false, code: "unsupported_content", status: 200 });
  });

  it("Given 아주 느리게 보내는 응답 When 전체 시간 한도를 넘기면 Then 시간 초과다", async () => {
    const started = Date.now();
    expect(await read("/trickle", { totalMs: 300 })).toEqual({ ok: false, code: "timeout", status: 200 });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("Given HTML이 아닌 응답 When 읽으면 Then 지원하지 않는 형식이다", async () => {
    expect(await read("/png")).toEqual({ ok: false, code: "unsupported_content", status: 200 });
  });

  it.each([
    [403, "blocked_by_site"], [401, "blocked_by_site"], [429, "blocked_by_site"], [451, "blocked_by_site"],
    [404, "http_status"], [500, "http_status"], [304, "http_status"],
  ])("Given %d 응답 When 읽으면 Then %s다", async (status, code) => {
    expect(await read(`/${status}`)).toEqual({ ok: false, code, status });
  });

  it("Given 쿠키 없는 요청 When 읽으면 Then 쿠키·리퍼러·인증 없이 moti 사용자 에이전트로 요청한다", async () => {
    await read("/ok");
    expect(seen).toHaveLength(1);
    const { headers } = seen[0];
    expect(headers.cookie).toBeUndefined();
    expect(headers.referer).toBeUndefined();
    expect(headers.authorization).toBeUndefined();
    expect(headers["user-agent"]).toBe("Mozilla/5.0 (compatible; moti/0.1; +https://github.com/seungmin-park/moti)");
    expect(headers["accept-language"]).toBe("ko-KR,ko;q=0.9,en;q=0.5");
  });

  it("Given 문서의 meta에만 EUC-KR을 밝힌 페이지 When 읽으면 Then 한글을 바르게 푼다", async () => {
    expect(await read("/euc-kr")).toMatchObject({ ok: true, page: { html: expect.stringContaining("<title>가방</title>") } });
  });

  it("Given 없는 이름과 닫힌 포트 When 읽으면 Then DNS 실패와 연결 실패로 구분한다", async () => {
    expect(await read(`http://missing.test:${port}/ok`)).toEqual({ ok: false, code: "dns_failed", status: null });
    expect(await read(`http://127.0.0.1:${closedPort}/ok`)).toEqual({ ok: false, code: "connect_failed", status: null });
  });

  it.each(["not a url", "ftp://shop.example/item", "http://user:pw@shop.example/"])(
    "Given %s When 읽으면 Then 열 수 없는 주소다",
    async (url) => {
      expect(await source().read(url)).toEqual({ ok: false, code: "invalid_url", status: null });
    },
  );
});
