import { describe, expect, it } from "vitest";
import type { CollectionResponse, ProductResponse } from "../presentation/library-dto";
import { canRetry, toProductCardView, toProductDetailView } from "./product-view";

const desk: CollectionResponse = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "책상",
  revision: 1,
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
};
const room: CollectionResponse = { ...desk, id: "33333333-3333-4333-8333-333333333333", name: "방" };
const kitchen: CollectionResponse = { ...desk, id: "55555555-5555-4555-8555-555555555555", name: "주방" };

const queued: ProductResponse = {
  id: "22222222-2222-4222-8222-222222222222",
  sourceUrl: "https://www.shop.example/item?utm_source=a",
  identityUrl: "https://www.shop.example/item",
  option: "",
  shop: "shop.example",
  title: "새로 담은 상품",
  note: "",
  revision: 1,
  collectionIds: [],
  addedAt: "2026-11-10T16:00:00.000Z",
  updatedAt: "2026-11-10T16:00:00.000Z",
  purchase: { status: "wish" },
  metadata: { phase: "queued", generation: 1, attempts: 0, stalled: false },
  lastSuccessfulPrice: null,
  picture: null,
};

const everyPhase: ProductResponse["metadata"][] = [
  { phase: "queued", generation: 1, attempts: 0, stalled: false },
  { phase: "running", generation: 1, attempts: 1, stalled: false },
  { phase: "failed", generation: 1, attempts: 3, errorCode: "blocked_address" },
  { phase: "ready", generation: 1, attempts: 1, completedAt: "2026-11-11T00:00:00.000Z", image: { outcome: "absent" } },
];

describe("상품 카드 문구", () => {
  it("Given 막 담은 링크 When 카드로 보이면 Then 저장한 정보와 수집 대기·가격 확인 전·미분류를 그대로 말한다", () => {
    expect(toProductCardView(queued, [desk])).toEqual({
      shop: "shop.example",
      title: "새로 담은 상품",
      option: "옵션 미입력",
      status: "정보 수집 대기",
      purchased: false,
      price: { value: "가격 확인 전", checked: null },
      collection: { filed: false, text: "아직 분류하지 않았어요" },
      picture: { kind: "placeholder", icon: "waiting", text: "사진을 가져오는 중" },
    });
  });

  it.each([
    ["queued", "정보 수집 대기"],
    ["running", "정보 수집 중"],
    ["failed", "정보를 가져오지 못했어요"],
    ["ready", null],
  ] as const)("Given 수집 단계 %s When 카드로 보이면 Then 상태 표시는 %j다", (phase, status) => {
    const metadata = everyPhase.find((item) => item.phase === phase)!;
    expect(toProductCardView({ ...queued, metadata }, []).status).toBe(status);
  });

  it("Given 마지막으로 확인한 원화 가격 When 카드로 보이면 Then 최소 단위를 통화로 바꾸고 서울 날짜로 확인일을 붙인다", () => {
    const product = { ...queued, lastSuccessfulPrice: { amountMinor: 289000, currency: "KRW", checkedAt: "2026-11-10T16:30:00.000Z" } };
    expect(toProductCardView(product, []).price).toEqual({ value: "₩289,000", checked: "마지막 확인 2026. 11. 11." });
  });

  it("Given 소수 단위가 있는 통화 When 카드로 보이면 Then 통화의 소수 자릿수로 나눈다", () => {
    const product = { ...queued, lastSuccessfulPrice: { amountMinor: 1999, currency: "USD", checkedAt: "2026-11-11T00:00:00.000Z" } };
    expect(toProductCardView(product, []).price.value).toBe("US$19.99");
  });

  it("Given 구매한 상품 When 카드로 보이면 Then 구매완료를 표시하고, 위시 상품은 표시하지 않는다", () => {
    const purchased = { ...queued, purchase: { status: "purchased" as const, date: null, price: null } };
    expect(toProductCardView(purchased, []).purchased).toBe(true);
    expect(toProductCardView(queued, []).purchased).toBe(false);
  });

  it("Given 여러 컬렉션 When 카드로 보이면 Then 첫 컬렉션 이름과 나머지 개수를 보여주고 모르는 id는 세지 않는다", () => {
    const product = { ...queued, collectionIds: [room.id, "99999999-9999-4999-8999-999999999999", desk.id, kitchen.id] };
    expect(toProductCardView(product, [desk, room, kitchen]).collection).toEqual({ filed: true, text: "방 +2" });
    expect(toProductCardView({ ...queued, collectionIds: [desk.id] }, [desk]).collection).toEqual({ filed: true, text: "책상" });
  });

  it("Given 옵션을 적은 상품 When 카드로 보이면 Then 옵션을 그대로 보여준다", () => {
    expect(toProductCardView({ ...queued, option: "블랙 · 250mm" }, []).option).toBe("블랙 · 250mm");
  });
});

describe("상품 상세 문구", () => {
  it("Given 막 담은 링크 When 상세로 보이면 Then 정보를 아직 가져오지 않았고 원본 링크는 보관했다고 말한다", () => {
    expect(toProductDetailView({ ...queued, collectionIds: [desk.id, room.id] }, [desk, room], null)).toEqual({
      shop: "shop.example",
      title: "새로 담은 상품",
      option: "옵션 미입력",
      purchased: false,
      price: { value: "가격 확인 전", checked: null },
      status: { title: "정보 수집 대기", detail: "상품 정보는 아직 가져오지 않았어요. 원본 링크는 보관했어요." },
      sourceUrl: "https://www.shop.example/item?utm_source=a",
      openUrl: "https://www.shop.example/item?utm_source=a",
      collectionNames: ["책상", "방"],
      addedOn: "2026. 11. 11.",
      note: null,
      arrival: null,
      canRetry: false,
      picture: { kind: "placeholder", icon: "waiting", text: "사진을 가져오는 중" },
    });
  });

  it.each([
    ["running", "정보 수집 중", "상품 정보는 아직 가져오지 않았어요. 원본 링크는 보관했어요."],
    ["failed", "정보를 가져오지 못했어요", "안전을 위해 열지 않는 주소예요. 원본 링크는 그대로 보관했어요."],
    ["ready", "상품 정보를 가져왔어요", "2026. 11. 11.에 확인했어요."],
  ] as const)("Given 수집 단계 %s When 상세로 보이면 Then 그 단계를 설명한다", (phase, title, detail) => {
    const metadata = everyPhase.find((item) => item.phase === phase)!;
    expect(toProductDetailView({ ...queued, metadata }, [], null).status).toEqual({ title, detail });
  });

  it("Given http(s)가 아닌 원본 주소 When 상세로 보이면 Then 주소는 보여주되 열기 링크는 만들지 않는다", () => {
    for (const sourceUrl of ["javascript:alert(1)", "data:text/html,hi", "not a url"]) {
      const view = toProductDetailView({ ...queued, sourceUrl }, [], null);
      expect(view.sourceUrl).toBe(sourceUrl);
      expect(view.openUrl).toBeNull();
    }
  });

  it("Given 저장 결과 When 상세로 보이면 Then 담았다·이미 담았다 안내를 고른다", () => {
    expect(toProductDetailView(queued, [], "added").arrival).toBe("위시에 담았어요");
    expect(toProductDetailView(queued, [], "duplicate").arrival).toBe("이미 담아둔 상품이에요");
  });

  it("Given 메모가 있는 상품 When 상세로 보이면 Then 메모를 보여주고 공백뿐이면 숨긴다", () => {
    expect(toProductDetailView({ ...queued, note: "선물용" }, [], null).note).toBe("선물용");
    expect(toProductDetailView({ ...queued, note: "  " }, [], null).note).toBeNull();
  });
});

describe("수집 결과와 다시 가져오기", () => {
  const failed = (errorCode: Extract<ProductResponse["metadata"], { phase: "failed" }>["errorCode"]): ProductResponse =>
    ({ ...queued, metadata: { phase: "failed", generation: 1, attempts: 1, errorCode } });

  it.each([
    ["blocked_address", "안전을 위해 열지 않는 주소예요."],
    ["blocked_by_site", "쇼핑몰이 자동 확인을 막았어요."],
    ["timeout", "쇼핑몰이 제때 응답하지 않았어요."],
    ["no_product_data", "페이지에서 상품 정보를 찾지 못했어요."],
    ["dns_failed", "쇼핑몰 주소를 찾지 못했어요."],
    ["attempts_exhausted", "여러 번 시도했지만 가져오지 못했어요."],
  ] as const)("Given %s로 실패 When 상세로 보이면 Then 이유와 링크 보관을 함께 말한다", (code, reason) => {
    expect(toProductDetailView(failed(code), [], null).status)
      .toEqual({ title: "정보를 가져오지 못했어요", detail: `${reason} 원본 링크는 그대로 보관했어요.` });
  });

  it("Given 모든 실패 코드 When 상세로 보이면 Then 저마다 비어 있지 않은 이유가 있다", () => {
    const codes = ["invalid_url", "blocked_address", "dns_failed", "connect_failed", "timeout", "too_many_redirects",
      "blocked_by_site", "http_status", "unsupported_content", "too_large", "decode_failed", "no_product_data",
      "attempts_exhausted", "internal"] as const;
    const details = codes.map((code) => toProductDetailView(failed(code), [], null).status.detail);
    expect(new Set(details).size).toBe(codes.length);
    expect(details.every((detail) => detail.endsWith(" 원본 링크는 그대로 보관했어요."))).toBe(true);
  });

  it("Given 멈춘 작업 When 카드와 상세로 보이면 Then 멈췄다고 말하고 다시 가져올 수 있다", () => {
    const stalled: ProductResponse = { ...queued, metadata: { phase: "running", generation: 1, attempts: 1, stalled: true } };
    expect(toProductCardView(stalled, []).status).toBe("정보 수집 멈춤");
    expect(toProductDetailView(stalled, [], null)).toMatchObject({
      status: { title: "정보 수집이 멈췄어요", detail: "다시 가져오기를 눌러 주세요. 원본 링크는 그대로 보관했어요." },
      canRetry: true,
    });
  });

  it("Given 수집 단계 When 다시 가져올 수 있는지 보면 Then 실패했거나 멈춘 경우만 가능하다", () => {
    expect(canRetry(failed("timeout"))).toBe(true);
    expect(canRetry({ ...queued, metadata: { phase: "queued", generation: 1, attempts: 0, stalled: true } })).toBe(true);
    for (const metadata of everyPhase.filter((item) => item.phase !== "failed")) {
      expect(canRetry({ ...queued, metadata })).toBe(false);
    }
    expect(toProductDetailView(failed("timeout"), [], null).canRetry).toBe(true);
  });

  it("Given 정보를 가져온 상품 When 카드와 상세로 보이면 Then 가져온 이름과 가격을 보여준다", () => {
    const ready: ProductResponse = {
      ...queued,
      title: "무선 헤드폰 블랙",
      metadata: { phase: "ready", generation: 1, attempts: 1, completedAt: "2026-11-11T00:00:00.000Z", image: { outcome: "absent" } },
      lastSuccessfulPrice: { amountMinor: 289000, currency: "KRW", checkedAt: "2026-11-11T00:00:00.000Z" },
    };
    expect(toProductCardView(ready, [])).toMatchObject({ title: "무선 헤드폰 블랙", status: null, price: { value: "₩289,000" } });
    expect(toProductDetailView(ready, [], null)).toMatchObject({ title: "무선 헤드폰 블랙", canRetry: false });
  });
});

describe("실제 데이터만 말하기", () => {
  it("Given 모든 수집 단계·가격·구매 상태 When 카드와 상세로 보이면 Then 어떤 문구에도 예시가 없다", () => {
    for (const metadata of everyPhase) {
      for (const lastSuccessfulPrice of [null, { amountMinor: 1000, currency: "KRW", checkedAt: "2026-11-11T00:00:00.000Z" }]) {
        for (const purchase of [{ status: "wish" as const }, { status: "purchased" as const, date: null, price: null }]) {
          const product = { ...queued, metadata, lastSuccessfulPrice, purchase, collectionIds: [desk.id] };
          for (const arrival of ["added", "duplicate", null] as const) {
            const text = JSON.stringify([toProductCardView(product, [desk]), toProductDetailView(product, [desk], arrival)]);
            expect(text).not.toContain("예시");
          }
        }
      }
    }
  });
});

describe("상품 사진", () => {
  const src = "/api/products/22222222-2222-4222-8222-222222222222/picture?v=77777777-7777-4777-8777-777777777777";
  type Image = Extract<ProductResponse["metadata"], { phase: "ready" }>["image"];
  const ready = (image: Image, picture: ProductResponse["picture"] = null): ProductResponse => ({
    ...queued,
    title: "무선 헤드폰",
    metadata: { phase: "ready", generation: 1, attempts: 1, completedAt: "2026-11-11T00:00:00.000Z", image },
    picture,
  });
  const failed = everyPhase.find((item) => item.phase === "failed")!;
  const running = everyPhase.find((item) => item.phase === "running")!;

  it("Given 사본이 있는 상품 When 카드와 상세로 보이면 Then 같은 출처 주소로 사진을 보이고 상세는 이름을 대체 글로 쓴다", () => {
    const product = ready({ outcome: "copied" }, { src });
    expect(toProductCardView(product, []).picture).toEqual({ kind: "photo", src, alt: "" });
    expect(toProductDetailView(product, [], null).picture).toEqual({ kind: "photo", src, alt: "무선 헤드폰 사진" });
  });

  it.each<[string, ProductResponse, string, string]>([
    ["사진이 없는 페이지", ready({ outcome: "absent" }), "link", "링크를 담아두었어요"],
    ["수집 대기", queued, "waiting", "사진을 가져오는 중"],
    ["수집 중", { ...queued, metadata: running }, "waiting", "사진을 가져오는 중"],
    ["사진만 실패", ready({ outcome: "failed", errorCode: "blocked_by_site" }), "off", "사진을 가져오지 못했어요"],
    ["페이지 실패", { ...queued, metadata: failed }, "link", "링크를 담아두었어요"],
    ["멈춘 수집", { ...queued, metadata: { phase: "running", generation: 1, attempts: 1, stalled: true } }, "link", "링크를 담아두었어요"],
  ])("Given %s이고 사본이 없음 When 보이면 Then 그 상태에 맞는 중립 자리표시를 쓴다", (_, product, icon, text) => {
    expect(toProductCardView(product, []).picture).toEqual({ kind: "placeholder", icon, text });
    expect(toProductDetailView(product, [], null).picture).toEqual({ kind: "placeholder", icon, text });
  });

  it("Given 이전 사본이 있고 이번 사진은 실패 When 보이면 Then 이전 사본을 계속 보인다", () => {
    expect(toProductCardView(ready({ outcome: "failed", errorCode: "timeout" }, { src }), []).picture).toEqual({ kind: "photo", src, alt: "" });
  });

  it("Given 사진을 가져오지 못한 상품 When 상세로 보이면 Then 이유와 이름·가격은 가져왔다는 말을 하고 다시 가져올 수 있다", () => {
    const view = toProductDetailView(ready({ outcome: "failed", errorCode: "blocked_by_site" }), [], null);
    expect(view.status).toEqual({ title: "사진을 가져오지 못했어요", detail: "쇼핑몰이 사진 요청을 막았어요. 이름과 가격은 가져왔어요." });
    expect(view.canRetry).toBe(true);
    expect(toProductCardView(ready({ outcome: "failed", errorCode: "blocked_by_site" }), []).status).toBeNull();
    expect(canRetry(ready({ outcome: "copied" }, { src }))).toBe(false);
    expect(canRetry(ready({ outcome: "absent" }))).toBe(false);
  });
});
