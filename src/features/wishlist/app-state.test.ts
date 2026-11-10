import { describe, expect, it } from "vitest";
import { createDemoSession } from "./model";
import { reduceApp, type AppState, type Modal } from "./app-state";

function addingLink(): AppState {
  return {
    session: createDemoSession(),
    modal: { kind: "add", collectionIds: ["c-gift"] },
  };
}

describe("링크 추가 중 컬렉션 생성과 선택", () => {
  it("생성된 컬렉션을 즉시 선택하고 기존 선택과 추가 창을 유지한다", () => {
    const before = addingLink();

    const after = reduceApp(before, { type: "add.collection.create", name: " 여름 여행 " });

    const created = after.session.collections.find((collection) => collection.name === "여름 여행");
    expect(created).toBeDefined();
    expect(after.modal).toEqual({ kind: "add", collectionIds: ["c-gift", created?.id] });
    expect(after.session.collections).toHaveLength(before.session.collections.length + 1);
    expect(after.session.products).toEqual(before.session.products);
    expect(after.session.nextId).toBe(before.session.nextId + 1);
  });

  it("같은 이름의 빠른 연속 생성은 하나만 만들고 이미 선택한 ID를 보존한다", () => {
    const before = addingLink();
    const created = reduceApp(before, { type: "add.collection.create", name: "My Gear" });

    const duplicate = reduceApp(created, { type: "add.collection.create", name: " my gear " });

    expect(duplicate.session.collections).toHaveLength(before.session.collections.length + 1);
    expect(duplicate.session.collections).toEqual(created.session.collections);
    expect(duplicate.session.nextId).toBe(created.session.nextId);
    expect(duplicate.modal).toEqual(created.modal);
    expect(duplicate.session.feedback).toMatchObject({ kind: "invalid", field: "collection" });
  });

  it.each(["", "  ", "가".repeat(41), "나를 위한 선물"])("잘못된 이름 %j는 컬렉션과 선택을 변경하지 않는다", (name) => {
    const before = addingLink();

    const after = reduceApp(before, { type: "add.collection.create", name });

    expect(after.modal).toEqual(before.modal);
    expect(after.session.collections).toEqual(before.session.collections);
    expect(after.session.products).toEqual(before.session.products);
    expect(after.session.nextId).toBe(before.session.nextId);
    expect(after.session.feedback).toMatchObject({ kind: "invalid", field: "collection" });
  });

  it("추가 창 밖의 인라인 생성과 선택 요청은 상태를 바꾸지 않는다", () => {
    for (const modal of [null, { kind: "collection" }, { kind: "detail", id: "headphones" }] satisfies (Modal | null)[]) {
      const before = { session: createDemoSession(), modal };
      expect(reduceApp(before, { type: "add.collection.create", name: "여행" })).toEqual(before);
      expect(reduceApp(before, { type: "add.collection.toggle", id: "c-home" })).toEqual(before);
    }
  });

  it("현재 컬렉션을 추가·해제하고 존재하지 않는 컬렉션은 선택하지 않는다", () => {
    const before = addingLink();
    const selected = reduceApp(before, { type: "add.collection.toggle", id: "c-home" });

    expect(selected.modal).toEqual({ kind: "add", collectionIds: ["c-gift", "c-home"] });
    expect(reduceApp(selected, { type: "add.collection.toggle", id: "missing" })).toEqual(selected);
    expect(reduceApp(selected, { type: "add.collection.toggle", id: "c-gift" }).modal)
      .toEqual({ kind: "add", collectionIds: ["c-home"] });
    expect(selected.session).toEqual(before.session);
  });

  it("기존 컬렉션 생성 창은 성공하면 닫힌다", () => {
    const before: AppState = { session: createDemoSession(), modal: { kind: "collection" } };

    const after = reduceApp(before, { type: "domain", command: { type: "collection.create", name: "새 공간" } });

    expect(after.modal).toBeNull();
    expect(after.session.collections.some((collection) => collection.name === "새 공간")).toBe(true);
  });

  it("링크 추가를 취소해도 사용자가 이미 만든 컬렉션은 유지한다", () => {
    const created = reduceApp(addingLink(), { type: "add.collection.create", name: "나중에 담을 곳" });

    const closed = reduceApp(created, { type: "close" });

    expect(closed.modal).toBeNull();
    expect(closed.session.collections.some((collection) => collection.name === "나중에 담을 곳")).toBe(true);
  });
});
