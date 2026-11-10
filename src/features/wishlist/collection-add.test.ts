import { describe, expect, it } from "vitest";
import { createDemoSession, reduceSession, type Session } from "./model";

const addToCollections = (session: Session, collectionIds: string[]) => {
  const command = {
    type: "link.add" as const,
    url: "https://example.com/collection-choice",
    option: "",
    at: "2026-11-11T06:00:00.000Z",
    collectionIds,
  };
  return reduceSession(session, command);
};

describe("링크를 담을 컬렉션 선택", () => {
  it("선택한 여러 컬렉션에 한 번씩 상품을 담는다", () => {
    const before = createDemoSession();
    const ids = before.collections.slice(0, 2).map((collection) => collection.id);

    const after = addToCollections(before, [...ids, ids[0]]);

    expect(after.products).toHaveLength(before.products.length + 1);
    expect(after.products[0].collectionIds).toEqual(ids);
    expect(after.feedback?.kind).toBe("added");
  });

  it("컬렉션을 고르지 않아도 링크를 담는다", () => {
    const after = addToCollections(createDemoSession(), []);

    expect(after.products[0].collectionIds).toEqual([]);
    expect(after.feedback?.kind).toBe("added");
  });

  it("선택 중 없는 컬렉션이 하나라도 있으면 상품과 ID를 변경하지 않는다", () => {
    const before = createDemoSession();

    const after = addToCollections(before, [before.collections[0].id, "missing"]);

    expect(after.products).toEqual(before.products);
    expect(after.nextId).toBe(before.nextId);
    expect(after.feedback).toMatchObject({ kind: "invalid", field: "collection" });
  });

  it("중복 링크에 새 컬렉션을 골라도 기존 메모와 소속을 덮어쓰지 않는다", () => {
    const initial = createDemoSession();
    const [first, second] = initial.collections;
    const added = addToCollections(initial, [first.id]);
    const edited = reduceSession(added, {
      type: "product.edit",
      id: added.products[0].id,
      title: "내가 고른 물건",
      note: "기존 메모",
      collectionIds: [first.id],
    });

    const duplicate = addToCollections(edited, [second.id]);

    expect(duplicate.products).toEqual(edited.products);
    expect(duplicate.feedback).toEqual({
      kind: "duplicate",
      productId: added.products[0].id,
    });
  });
});
