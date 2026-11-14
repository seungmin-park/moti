import { describe, expect, it, vi } from "vitest";
import type { ShareLinkAddCommand, ShareLinkAddResult } from "../application/commands";
import { ShareError, type ShareErrorCode } from "../domain/share-key";
import { MAX_SHARE_BYTES, shareLinkAddResponseSchema, shareLinkErrorResponseSchema } from "./share-dto";
import { createShareHandlers, type ShareRequestContext } from "./share-handlers";

const secret = `moti_sk_${"AbcdEfghIjklMnopQrstUvwxYz0123456789-_AbCdE"}`;
const url = "https://shop.example/lamp?utm_source=share";
const path = "https://moti.test/api/share/links";

function given(configured = true) {
  const add = vi.fn<(command: ShareLinkAddCommand) => Promise<ShareLinkAddResult>>(async () => ({ kind: "added" }));
  const context = vi.fn(async (): Promise<ShareRequestContext> => (configured ? { kind: "ready", service: { add } } : { kind: "unconfigured" }));
  return { handlers: createShareHandlers(context), add, context };
}

function share(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", ...headers },
    body,
  });
}
const shareUrl = (headers: Record<string, string> = {}) => share(JSON.stringify({ url }), headers);

async function expectShortcutAnswer(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("access-control-allow-origin")).toBeNull();
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  const body = (await response.json()) as { message?: unknown };
  expect(typeof body.message).toBe("string");
  return body;
}

async function errorOf(response: Response) {
  return shareLinkErrorResponseSchema.parse(await expectShortcutAnswer(response));
}

describe("POST /api/share/links: 저장 키", () => {
  it.each([
    ["Authorization 없음", {}],
    ["Basic 인증", { authorization: `Basic ${secret}` }],
    ["형식이 다른 키", { authorization: "Bearer moti_sk_short" }],
    ["작업 키", { authorization: `Bearer ${secret.replace("moti_sk_", "moti_wk_")}` }],
    ["두 Authorization 값", { authorization: `Bearer ${secret}, Bearer ${secret}` }],
    ["소유자 쿠키만", { cookie: "sb-127-auth-token=base64-eyJhY2Nlc3NfdG9rZW4iOiJ4In0" }],
  ])("Given %s When 링크를 공유하면 Then 401이고 본문을 읽지 않으며 저장소를 부르지 않는다", async (_name, headers) => {
    const { handlers, add, context } = given();
    const request = new Request(path, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ url }),
    });

    const response = await handlers.postShareLink(request);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(await errorOf(response)).toEqual({
      error: "share_key_rejected",
      message: "저장 키가 맞지 않거나 폐기됐어요. moti의 공유 저장 화면에서 새 키를 만들어 단축어에 넣어 주세요.",
    });
    expect(request.bodyUsed).toBe(false);
    expect(context).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("Given 모르는 키와 폐기한 키 When 저장소가 거절하면 Then 형식이 틀린 키와 바이트까지 같은 401이다", async () => {
    const malformed = await given().handlers.postShareLink(shareUrl({ authorization: "Bearer nope" }));
    const { handlers, add } = given();
    add.mockRejectedValueOnce(new ShareError("key_rejected", "unknown"));
    const unknown = await handlers.postShareLink(shareUrl());
    add.mockRejectedValueOnce(new ShareError("key_rejected", "revoked"));
    const revoked = await handlers.postShareLink(shareUrl());

    const bodies = await Promise.all([malformed, unknown, revoked].map((response) => response.text()));
    expect(new Set([malformed, unknown, revoked].map((response) => response.status))).toEqual(new Set([401]));
    expect(new Set(bodies).size).toBe(1);
  });

  it("Given 다른 사이트의 Origin과 맞는 키 When 링크를 공유하면 Then 출처를 묻지 않고 담는다", async () => {
    const { handlers, add } = given();
    const response = await handlers.postShareLink(shareUrl({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }));
    expect(response.status).toBe(201);
    expect(add).toHaveBeenCalledOnce();
  });
});

describe("POST /api/share/links: 본문", () => {
  it.each([
    ["JSON이 아닌 형식", 415, "unsupported_media_type", () => share(JSON.stringify({ url }), { "content-type": "text/plain" })],
    ["선언한 크기 초과", 413, "payload_too_large", () => share(JSON.stringify({ url }), { "content-length": String(MAX_SHARE_BYTES + 1) })],
    ["실제 크기 초과", 413, "payload_too_large", () => share(JSON.stringify({ url: `https://shop.example/${"x".repeat(MAX_SHARE_BYTES)}` }))],
    ["깨진 JSON", 400, "invalid_link", () => share("{\"url\":")],
    ["객체가 아닌 JSON", 400, "invalid_link", () => share(JSON.stringify([url]))],
    ["url 없음", 400, "invalid_link", () => share(JSON.stringify({}))],
    ["다른 필드", 400, "invalid_link", () => share(JSON.stringify({ url, option: "블랙" }))],
    ["문자열이 아닌 url", 400, "invalid_link", () => share(JSON.stringify({ url: 1 }))],
    ["링크가 아닌 글", 400, "invalid_link", () => share(JSON.stringify({ url: "이 상품 어때요" }))],
    ["링크 없는 여러 줄 글", 400, "invalid_link", () => share(JSON.stringify({ url: "쿠팡을 추천합니다!\n로투스 벨기에 와플 초코" }))],
    ["단축어 입력이 비어 있음", 400, "invalid_link", () => share(JSON.stringify({ url: "" }))],
    ["javascript 링크", 400, "invalid_link", () => share(JSON.stringify({ url: "javascript:alert(1)" }))],
  ] as const)("Given %s When 링크를 공유하면 Then %i %s이고 저장소를 부르지 않는다", async (_name, status, code, request) => {
    const { handlers, add } = given();
    const response = await handlers.postShareLink(request());
    expect(response.status).toBe(status);
    expect((await errorOf(response)).error).toBe(code);
    expect(add).not.toHaveBeenCalled();
  });

  it("Given 스트림으로 보낸 큰 본문 When 링크를 공유하면 Then 한도에서 읽기를 멈추고 413이다", async () => {
    const { handlers, add } = given();
    const chunk = new TextEncoder().encode("x".repeat(1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 64) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const request = new Request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    const response = await handlers.postShareLink(request);
    expect(response.status).toBe(413);
    expect(sent).toBeLessThan(64);
    expect(add).not.toHaveBeenCalled();
  });
});

describe("POST /api/share/links: 결과", () => {
  it("Given 맞는 키와 상품 링크 When 새 링크를 공유하면 Then 201과 담았다는 메시지이고 키와 다듬은 링크로 저장소를 부른다", async () => {
    const { handlers, add } = given();
    const response = await handlers.postShareLink(share(JSON.stringify({ url: `  ${url} ` })));
    expect(response.status).toBe(201);
    expect(shareLinkAddResponseSchema.parse(await expectShortcutAnswer(response))).toEqual({
      result: "added",
      message: "위시에 담았어요. 상품 정보는 moti를 열면 가져와요.",
    });
    expect(add).toHaveBeenCalledWith({
      secret,
      link: { sourceUrl: url, identityUrl: "https://shop.example/lamp", option: "", shop: "shop.example" },
      title: null,
    });
  });

  it("Given 쿠팡 앱이 단축어에 넘긴 글 When 같은 url 칸으로 공유하면 Then 201이고 글 속 링크와 그 위 줄의 이름으로 저장소를 부른다", async () => {
    const { handlers, add } = given();
    const text = "쿠팡을 추천합니다!\n로투스 벨기에 와플 초코\nhttps://link.coupang.com/a/iGa1zKNs4a";
    const response = await handlers.postShareLink(share(JSON.stringify({ url: text })));
    expect(response.status).toBe(201);
    expect(shareLinkAddResponseSchema.parse(await expectShortcutAnswer(response)).result).toBe("added");
    expect(add).toHaveBeenCalledWith({
      secret,
      link: {
        sourceUrl: "https://link.coupang.com/a/iGa1zKNs4a",
        identityUrl: "https://link.coupang.com/a/iGa1zKNs4a",
        option: "",
        shop: "link.coupang.com",
      },
      title: "로투스 벨기에 와플 초코",
    });
  });

  it("Given 이미 담은 링크 When 공유하면 Then 200과 이미 담았다는 메시지만 돌려준다", async () => {
    const { handlers, add } = given();
    add.mockResolvedValueOnce({ kind: "duplicate" });
    const response = await handlers.postShareLink(shareUrl());
    expect(response.status).toBe(200);
    expect(shareLinkAddResponseSchema.parse(await expectShortcutAnswer(response))).toEqual({
      result: "duplicate",
      message: "이미 담아둔 상품이에요.",
    });
  });

  it.each([
    ["key_rejected", 401, "share_key_rejected"],
    ["key_busy", 429, "share_key_busy"],
    ["invalid_input", 400, "invalid_link"],
    ["identity_conflict", 409, "identity_conflict"],
    ["storage_unavailable", 503, "unavailable"],
  ] as const)("Given 저장소의 %s When 공유하면 Then %i %s이다", async (code: ShareErrorCode, status, error) => {
    const { handlers, add } = given();
    add.mockRejectedValueOnce(new ShareError(code, "db"));
    const response = await handlers.postShareLink(shareUrl());
    expect(response.status).toBe(status);
    expect((await errorOf(response)).error).toBe(error);
  });

  it("Given 예상하지 못한 오류 When 공유하면 Then 503 unavailable이다", async () => {
    const { handlers, add } = given();
    add.mockRejectedValueOnce(new Error("network"));
    const response = await handlers.postShareLink(shareUrl());
    expect(response.status).toBe(503);
    expect(await errorOf(response)).toEqual({ error: "unavailable", message: "지금은 moti에 담지 못했어요. 잠시 뒤 다시 공유해 주세요." });
  });

  it("Given Supabase 설정 없음 When 맞는 형식의 키로 공유하면 Then 503 unconfigured이고 본문을 읽지 않는다", async () => {
    const { handlers, add } = given(false);
    const request = shareUrl();
    const response = await handlers.postShareLink(request);
    expect(response.status).toBe(503);
    expect((await errorOf(response)).error).toBe("unconfigured");
    expect(request.bodyUsed).toBe(false);
    expect(add).not.toHaveBeenCalled();
  });

  it("Given 요청 정보를 만들다 실패 When 공유하면 Then 503 unavailable이다", async () => {
    const handlers = createShareHandlers(async () => { throw new Error("config"); });
    const response = await handlers.postShareLink(shareUrl());
    expect(response.status).toBe(503);
    expect((await errorOf(response)).error).toBe("unavailable");
  });
});
