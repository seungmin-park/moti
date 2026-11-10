import { describe, expect, it } from "vitest";
import {
  createDemoSession,
  reduceSession,
  selectProducts,
  type Session,
  type ProductQuery,
} from "./model";

const at = "2026-11-11T06:00:00.000Z";
const empty = (): Session => ({
  products: [],
  collections: [],
  nextId: 1,
  revision: 0,
  feedback: null,
  undo: null,
});

describe("사용자에게 보이는 가격 정렬", () => {
  it.each([
    ["price-low", ["old-bag", "old-lamp", "headphones"]],
    ["price-high", ["old-lamp", "old-bag", "headphones"]],
  ] as const)(
    "구매완료는 실구매가로 %s 정렬하며 미입력을 마지막에 둔다",
    (sort, ids) => {
      let state = createDemoSession();
      state = reduceSession(state, {
        type: "product.purchase",
        id: "headphones",
      });
      state = reduceSession(state, {
        type: "purchase.details",
        id: "old-lamp",
        date: "",
        price: "1000000",
      });
      state = reduceSession(state, {
        type: "purchase.details",
        id: "old-bag",
        date: "",
        price: "0",
      });

      const products = selectProducts(state, {
        ...query,
        status: "purchased",
        sort,
      });

      expect(products.map((product) => product.id)).toEqual(ids);
    },
  );

  it.each([
    ["price-low", ["lamp", "speaker", "chair", "old-lamp", "headphones"]],
    ["price-high", ["old-lamp", "chair", "speaker", "lamp", "headphones"]],
  ] as const)(
    "혼합 컬렉션에서도 카드에 표시하는 가격으로 %s 정렬한다",
    (sort, ids) => {
      let state = createDemoSession();
      state = reduceSession(state, {
        type: "product.purchase",
        id: "headphones",
      });
      state = reduceSession(state, {
        type: "product.edit",
        id: "headphones",
        title: "무선 헤드폰",
        note: "",
        collectionIds: ["c-home"],
      });
      state = reduceSession(state, {
        type: "purchase.details",
        id: "old-lamp",
        date: "",
        price: "1000000",
      });

      const products = selectProducts(state, {
        ...query,
        status: "all",
        collectionId: "c-home",
        sort,
      });

      expect(products.map((product) => product.id)).toEqual(ids);
    },
  );
});
const add = (
  state = empty(),
  url = "https://example.com/item?size=M",
  option = "",
) => reduceSession(state, { type: "link.add", url, option, at });
const query: ProductQuery = {
  status: "wish",
  query: "",
  category: "all",
  collectionId: null,
  sort: "newest",
};

describe("링크 보관", () => {
  it("정보 수집 전에 원본 URL을 보관한다", () => {
    const state = add();
    expect(state.products).toHaveLength(1);
    expect(state.products[0]).toMatchObject({
      sourceUrl: "https://example.com/item?size=M",
      metadata: { phase: "collecting", attempt: 1 },
      purchase: { status: "wish" },
    });
    expect(state.feedback?.kind).toBe("added");
  });
  it.each([
    "",
    "문자열",
    "javascript:alert(1)",
    "ftp://example.com",
    "https://name:secret@example.com",
  ])("잘못된 URL %s는 상태를 변경하지 않는다", (url) => {
    const state = add(empty(), url);
    expect(state.products).toEqual([]);
    expect(state.feedback?.kind).toBe("invalid");
  });
  it("추적 파라미터만 다른 중복은 기존 상품과 메모를 보존한다", () => {
    const state = add(
      empty(),
      "https://example.com/item?size=M&utm_source=one",
    );
    const edited = reduceSession(state, {
      type: "product.edit",
      id: state.products[0].id,
      title: "나의 상품",
      note: "기억할 메모",
      collectionIds: [],
    });
    const duplicate = add(
      edited,
      "https://example.com/item?utm_medium=two&size=M",
    );
    expect(duplicate.products).toEqual(edited.products);
    expect(duplicate.feedback).toEqual({
      kind: "duplicate",
      productId: state.products[0].id,
    });
  });
  it("URL 옵션과 입력한 옵션이 다르면 각각 보관한다", () => {
    let state = add();
    state = add(state, "https://example.com/item?size=L");
    state = add(state, "https://example.com/item?size=M", "블랙");
    expect(state.products).toHaveLength(3);
  });
  it("수집 실패와 오래된 완료가 저장된 링크를 지우지 않는다", () => {
    const state = add();
    const id = state.products[0].id;
    const failed = reduceSession(state, {
      type: "metadata.resolve-demo",
      id,
      attempt: 1,
      outcome: "failure",
      at,
    });
    expect(failed.products[0].sourceUrl).toBe(state.products[0].sourceUrl);
    expect(failed.products[0].metadata.phase).toBe("failed");
    const retry = reduceSession(failed, { type: "metadata.retry", id });
    expect(retry.products[0].metadata).toEqual({
      phase: "collecting",
      attempt: 2,
    });
    expect(
      reduceSession(retry, {
        type: "metadata.resolve-demo",
        id,
        attempt: 1,
        outcome: "success",
        at,
      }),
    ).toBe(retry);
    expect(
      reduceSession(retry, {
        type: "metadata.resolve-demo",
        id,
        attempt: 2,
        outcome: "success",
        at,
      }).products[0].metadata.phase,
    ).toBe("ready");
  });
});

describe("구매와 컬렉션", () => {
  it("구매완료 뒤 메모를 바꾸어도 실행 취소가 현재 메모와 컬렉션을 보존한다", () => {
    let state = add();
    state = reduceSession(state, {
      type: "collection.create",
      name: "생일 선물",
    });
    const id = state.products[0].id;
    state = reduceSession(state, { type: "product.purchase", id });
    expect(state.products[0].purchase).toEqual({
      status: "purchased",
      date: null,
      price: null,
    });
    const token = state.undo!.token;
    state = reduceSession(state, {
      type: "product.edit",
      id,
      title: "제목",
      note: "나중에 쓴 메모",
      collectionIds: [state.collections[0].id],
    });
    state = reduceSession(state, { type: "purchase.undo", token });
    expect(state.products[0]).toMatchObject({
      purchase: { status: "wish" },
      note: "나중에 쓴 메모",
      collectionIds: [state.collections[0].id],
    });
    expect(state.undo).toBeNull();
  });
  it("중복 구매 명령과 이전 구매의 실행 취소는 새 구매를 변경하지 않는다", () => {
    const state = add();
    const id = state.products[0].id;
    const purchased = reduceSession(state, { type: "product.purchase", id });
    expect(reduceSession(purchased, { type: "product.purchase", id })).toBe(
      purchased,
    );
    const restored = reduceSession(purchased, { type: "product.restore", id });
    const next = reduceSession(restored, { type: "product.purchase", id });
    expect(
      reduceSession(next, {
        type: "purchase.undo",
        token: purchased.undo!.token,
      }),
    ).toBe(next);
  });
  it("빈 구매 정보와 0원을 구분하고 잘못된 값은 원자적으로 거절한다", () => {
    const state = add();
    const id = state.products[0].id;
    const purchased = reduceSession(state, { type: "product.purchase", id });
    const free = reduceSession(purchased, {
      type: "purchase.details",
      id,
      date: "2026-11-11",
      price: "0",
    });
    expect(free.products[0].purchase).toEqual({
      status: "purchased",
      date: "2026-11-11",
      price: 0,
    });
    for (const input of [
      { date: "2026-02-30", price: "100" },
      { date: "2026-11-11", price: "-1" },
      { date: "", price: "1.5" },
    ]) {
      const invalid = reduceSession(free, {
        type: "purchase.details",
        id,
        ...input,
      });
      expect(invalid.products).toEqual(free.products);
      expect(invalid.feedback?.kind).toBe("invalid");
    }
    expect(
      reduceSession(free, { type: "purchase.details", id, date: "", price: "" })
        .products[0].purchase,
    ).toEqual({ status: "purchased", date: null, price: null });
  });
  it("컬렉션 생성과 이름 변경이 상품 묶음을 보존한다", () => {
    let state = reduceSession(add(), {
      type: "collection.create",
      name: "  책상 꾸미기  ",
    });
    const id = state.collections[0].id;
    state = reduceSession(state, {
      type: "product.edit",
      id: state.products[0].id,
      title: "스탠드",
      note: "",
      collectionIds: [id, id],
    });
    state = reduceSession(state, {
      type: "collection.rename",
      id,
      name: "나의 작업실",
    });
    expect(state.collections).toEqual([{ id, name: "나의 작업실" }]);
    expect(state.products[0].collectionIds).toEqual([id]);
  });
  it("빈 컬렉션과 중복 이름, 없는 컬렉션 배정을 거절한다", () => {
    const state = reduceSession(add(), {
      type: "collection.create",
      name: "일상",
    });
    for (const name of [" ", " 일상 "]) {
      const invalid = reduceSession(state, { type: "collection.create", name });
      expect(invalid.collections).toEqual(state.collections);
      expect(invalid.feedback?.kind).toBe("invalid");
    }
    const invalid = reduceSession(state, {
      type: "product.edit",
      id: state.products[0].id,
      title: "상품",
      note: "",
      collectionIds: ["missing"],
    });
    expect(invalid.products).toEqual(state.products);
    expect(invalid.feedback?.kind).toBe("invalid");
  });
  it("컬렉션, 검색어, 구매 상태와 정렬을 함께 적용한다", () => {
    let state = add();
    state = reduceSession(state, { type: "collection.create", name: "책상" });
    const id = state.products[0].id;
    const collectionId = state.collections[0].id;
    state = reduceSession(state, {
      type: "product.edit",
      id,
      title: "검정 헤드폰",
      note: "",
      collectionIds: [collectionId],
    });
    state = add(state, "https://example.com/another");
    expect(
      selectProducts(state, { ...query, query: "헤드폰", collectionId }).map(
        (p) => p.id,
      ),
    ).toEqual([id]);
    expect(selectProducts(state, { ...query, status: "purchased" })).toEqual(
      [],
    );
    expect(selectProducts(state, { ...query, query: "없는 상품" })).toEqual([]);
  });
});
