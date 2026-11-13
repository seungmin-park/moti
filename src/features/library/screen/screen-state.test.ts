import { describe, expect, it, vi } from "vitest";
import type { CollectionResponse, LibraryReadResponse, ProductResponse } from "../presentation/library-dto";
import type { ApiFailure, LibraryApi } from "./library-api";
import {
  initialScreen,
  MAX_POLLS,
  perform,
  pollDelay,
  mergeProduct,
  transition,
  visibleProducts,
  visibleToast,
  type LibraryScreenState,
  type ScreenDialog,
  type ScreenEvent,
} from "./screen-state";

const desk: CollectionResponse = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Desk",
  revision: 1,
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
};
const room: CollectionResponse = { ...desk, id: "33333333-3333-4333-8333-333333333333", name: "방" };

function product(id: string, addedAt: string, collectionIds: string[] = []): ProductResponse {
  return {
    id,
    sourceUrl: `https://example.com/${id}`,
    identityUrl: `https://example.com/${id}`,
    option: "",
    shop: "example.com",
    title: "새로 담은 상품",
    note: "",
    revision: 1,
    collectionIds,
    addedAt,
    updatedAt: addedAt,
    purchase: { status: "wish" },
    metadata: { phase: "queued", generation: 1, attempts: 0, stalled: false },
    lastSuccessfulPrice: null,
    picture: null,
  };
}

const lamp = product("22222222-2222-4222-8222-222222222222", "2026-11-10T00:00:00.000Z", [desk.id]);
const chair = product("44444444-4444-4444-8444-444444444444", "2026-11-11T00:00:00.000Z");
const library: LibraryReadResponse = { products: [lamp, chair], collections: [desk, room] };
const unavailable: ApiFailure = { kind: "unavailable", message: "잠시 뒤 다시 시도해 주세요." };

type Ready = Extract<LibraryScreenState, { phase: "ready" }>;

function ready(overrides: Partial<Ready> = {}): Ready {
  return {
    phase: "ready", library, view: "wish", collectionId: null, dialog: null, refreshing: false, writing: null, toast: null, ...overrides,
  };
}

function adding(draft: Partial<{ url: string; option: string; collectionIds: string[] }> = {}, rest: Partial<Extract<ScreenDialog, { kind: "add" }>> = {}): Ready {
  return ready({
    dialog: {
      kind: "add",
      draft: { url: "https://shop.example/item", option: "", collectionIds: [], ...draft },
      saving: false,
      creating: null,
      error: null,
      ...rest,
    },
  });
}

function run(state: LibraryScreenState, ...events: ScreenEvent[]) {
  let current = { state, call: null as ReturnType<typeof transition>["call"] };
  for (const event of events) current = transition(current.state, event);
  return current;
}

function dialogOf(state: LibraryScreenState) {
  if (state.phase !== "ready") throw new Error(`ready가 아니에요: ${state.phase}`);
  return state.dialog;
}

describe("보관함 불러오기", () => {
  it("Given 처음 연 화면 When 시작하면 Then 불러오는 중이고 보관함을 요청한다", () => {
    expect(initialScreen).toEqual({ state: { phase: "loading" }, call: { type: "library.read" } });
  });

  it("Given 불러오는 중 When 보관함을 받으면 Then 필터와 대화상자 없이 보관함을 보여준다", () => {
    const { state, call } = transition({ phase: "loading" }, { type: "library.settled", outcome: { ok: true, value: library } });
    expect(state).toEqual(ready());
    expect(call).toBeNull();
  });

  it("Given 불러오는 중 When 일시적으로 실패하면 Then 실패 안내를 보여주고 다시 불러오기로 재요청한다", () => {
    const failed = transition({ phase: "loading" }, { type: "library.settled", outcome: { ok: false, failure: unavailable } });
    expect(failed).toEqual({ state: { phase: "failed", message: unavailable.message }, call: null });
    expect(transition(failed.state, { type: "retry" })).toEqual(initialScreen);
  });

  it("Given 불러오는 중 When 로그인이 필요하다는 응답을 받으면 Then 떠나는 상태가 되고 이후 이벤트를 모두 무시한다", () => {
    const leaving = transition({ phase: "loading" }, {
      type: "library.settled",
      outcome: { ok: false, failure: { kind: "redirect", to: "/login?error=forbidden" } },
    });
    expect(leaving).toEqual({ state: { phase: "leaving", to: "/login?error=forbidden" }, call: null });
    for (const event of [
      { type: "retry" },
      { type: "add.open" },
      { type: "library.settled", outcome: { ok: true, value: library } },
      { type: "link.settled", outcome: { ok: true, value: { kind: "added", product: lamp } } },
    ] satisfies ScreenEvent[]) {
      expect(transition(leaving.state, event)).toEqual({ state: leaving.state, call: null });
    }
  });
});

describe("목록과 필터", () => {
  it("Given 보관함 When 보이는 상품을 고르면 Then 최근 담은 순, 같은 시각이면 id 순이다", () => {
    const twin = product("00000000-0000-4000-8000-000000000000", chair.addedAt);
    expect(visibleProducts({ ...library, products: [lamp, chair, twin] }, "wish", null).map((item) => item.id))
      .toEqual([twin.id, chair.id, lamp.id]);
  });

  it("Given 컬렉션 필터 When 보이는 상품을 고르면 Then 그 컬렉션의 상품만 보여준다", () => {
    expect(visibleProducts(library, "wish", desk.id)).toEqual([lamp]);
    expect(visibleProducts(library, "wish", room.id)).toEqual([]);
  });

  it("Given 보관함 When 컬렉션 필터를 고르면 Then 그 컬렉션으로 거른다", () => {
    expect(run(ready(), { type: "filter", collectionId: desk.id }).state).toEqual(ready({ collectionId: desk.id }));
    expect(run(ready({ collectionId: desk.id }), { type: "filter", collectionId: null }).state).toEqual(ready());
  });
});

describe("링크 추가", () => {
  it("Given 컬렉션으로 거른 화면 When 링크 추가를 열면 Then 그 컬렉션을 미리 고른다", () => {
    expect(dialogOf(run(ready({ collectionId: desk.id }), { type: "add.open" }).state)).toEqual({
      kind: "add", draft: { url: "", option: "", collectionIds: [desk.id] }, saving: false, creating: null, error: null,
    });
    expect(dialogOf(run(ready(), { type: "add.open" }).state)).toMatchObject({ draft: { collectionIds: [] } });
  });

  it("Given 링크 추가 When 입력하고 컬렉션을 고르면 Then 초안에 남는다", () => {
    const { state } = run(ready(), { type: "add.open" }, { type: "add.edit", url: "https://a.example" },
      { type: "add.edit", option: "블랙" }, { type: "add.toggle", collectionId: room.id },
      { type: "add.toggle", collectionId: desk.id }, { type: "add.toggle", collectionId: room.id });
    expect(dialogOf(state)).toMatchObject({ draft: { url: "https://a.example", option: "블랙", collectionIds: [desk.id] } });
  });

  it("Given 서버 규칙에 맞지 않는 링크 When 담으면 Then 요청하지 않고 해당 칸에 오류를 보여준다", () => {
    const badUrl = run(adding({ url: "javascript:alert(1)" }), { type: "add.submit" });
    expect(badUrl.call).toBeNull();
    expect(dialogOf(badUrl.state)).toMatchObject({ saving: false, error: { field: "url" } });
    const longOption = run(adding({ option: "가".repeat(121) }), { type: "add.submit" });
    expect(longOption.call).toBeNull();
    expect(dialogOf(longOption.state)).toMatchObject({ error: { field: "option", message: "옵션은 120자까지 입력해 주세요." } });
  });

  it("Given 올바른 링크 When 담으면 Then 저장 중이 되고 초안 그대로 저장을 요청한다", () => {
    const { state, call } = run(adding({ option: "블랙", collectionIds: [desk.id] }, { error: { field: null, message: "이전 오류" } }),
      { type: "add.submit" });
    expect(call).toEqual({
      type: "link.save",
      body: { url: "https://shop.example/item", option: "블랙", collectionIds: [desk.id] },
    });
    expect(dialogOf(state)).toMatchObject({ saving: true, error: null });
  });

  it("Given 저장 중이거나 컬렉션을 만드는 중 When 다시 담으면 Then 두 번 요청하지 않는다", () => {
    const saving = adding({}, { saving: true });
    expect(run(saving, { type: "add.submit" })).toEqual({ state: saving, call: null });
    const creating = adding({}, { creating: "새 컬렉션" });
    expect(run(creating, { type: "add.submit" })).toEqual({ state: creating, call: null });
  });

  it("Given 저장 중 When 닫으면 Then 닫히지 않고, 저장 중이 아니면 닫힌다", () => {
    const saving = adding({}, { saving: true });
    expect(run(saving, { type: "dialog.close" }).state).toEqual(saving);
    expect(dialogOf(run(adding(), { type: "dialog.close" }).state)).toBeNull();
  });

  it("Given 저장 중 When 새 상품으로 저장되면 Then 맨 앞에 넣고 담았다는 상세를 연다", () => {
    const added = product("55555555-5555-4555-8555-555555555555", "2026-11-11T09:00:00.000Z");
    const { state, call } = run(adding({}, { saving: true }),
      { type: "link.settled", outcome: { ok: true, value: { kind: "added", product: added } } });
    expect(call).toBeNull();
    expect(state).toEqual(ready({
      library: { ...library, products: [added, lamp, chair] },
      dialog: { kind: "detail", productId: added.id, arrival: "added", error: null },
    }));
  });

  it("Given 저장 중 When 이미 담은 상품이라는 응답이면 Then 같은 상품을 바꿔 넣고 중복 안내 상세를 연다", () => {
    const updated = { ...lamp, revision: 2 };
    const { state } = run(adding({}, { saving: true }),
      { type: "link.settled", outcome: { ok: true, value: { kind: "duplicate", product: updated } } });
    expect(state).toEqual(ready({
      library: { ...library, products: [updated, chair] },
      dialog: { kind: "detail", productId: lamp.id, arrival: "duplicate", error: null },
    }));
  });

  it("Given 저장 중 When 입력 오류나 일시적 실패가 오면 Then 초안을 지키고 오류를 보여준다", () => {
    const draft = { url: "https://shop.example/item", option: "블랙", collectionIds: [desk.id] };
    const invalid = run(adding(draft, { saving: true }), {
      type: "link.settled", outcome: { ok: false, failure: { kind: "invalid", field: "option", message: "옵션을 확인해 주세요." } },
    });
    expect(dialogOf(invalid.state)).toEqual({
      kind: "add", draft, saving: false, creating: null, error: { field: "option", message: "옵션을 확인해 주세요." },
    });
    const failed = run(adding(draft, { saving: true }), { type: "link.settled", outcome: { ok: false, failure: unavailable } });
    expect(failed.call).toBeNull();
    expect(dialogOf(failed.state)).toEqual({
      kind: "add", draft, saving: false, creating: null, error: { field: null, message: unavailable.message },
    });
  });

  it("Given 저장 중 When 로그인이 필요하다는 응답이면 Then 로그인으로 떠난다", () => {
    expect(run(adding({}, { saving: true }), {
      type: "link.settled", outcome: { ok: false, failure: { kind: "redirect", to: "/login" } },
    })).toEqual({ state: { phase: "leaving", to: "/login" }, call: null });
  });
});

describe("오래된 화면 다시 맞추기", () => {
  const staleMessage = "선택한 컬렉션을 찾을 수 없어요. 목록을 새로 불러왔어요.";
  const draft = { url: "https://shop.example/item", option: "블랙", collectionIds: [desk.id, room.id] };

  function staleSave(collectionId: string | null = null) {
    return run({ ...adding(draft, { saving: true }), collectionId },
      { type: "link.settled", outcome: { ok: false, failure: { kind: "stale", message: staleMessage } } });
  }

  it("Given 저장 중 When 사라진 컬렉션 응답이면 Then 컬렉션 칸 오류와 함께 보관함을 다시 읽는다", () => {
    const { state, call } = staleSave();
    expect(call).toEqual({ type: "library.read" });
    expect(state).toMatchObject({ refreshing: true });
    expect(dialogOf(state)).toEqual({
      kind: "add", draft, saving: false, creating: null, error: { field: "collection", message: staleMessage },
    });
  });

  it("Given 다시 읽는 중 When 새 보관함을 받으면 Then 없어진 컬렉션만 초안에서 빼고 링크·옵션·오류는 지킨다", () => {
    const fresh = { products: [lamp, chair], collections: [room] };
    const { state, call } = transition(staleSave().state, { type: "library.settled", outcome: { ok: true, value: fresh } });
    expect(call).toBeNull();
    expect(state).toEqual(ready({
      library: fresh,
      dialog: {
        kind: "add",
        draft: { ...draft, collectionIds: [room.id] },
        saving: false,
        creating: null,
        error: { field: "collection", message: staleMessage },
      },
    }));
  });

  it("Given 다시 읽는 중 When 다시 읽기도 실패하면 Then 지금 보관함을 그대로 둔다", () => {
    const before = staleSave().state as Ready;
    const { state } = transition(before, { type: "library.settled", outcome: { ok: false, failure: unavailable } });
    expect(state).toEqual({ ...before, refreshing: false });
  });

  it("Given 거르던 컬렉션이 사라짐 When 새 보관함을 받으면 Then 필터를 전체로 되돌린다", () => {
    const { state } = transition(staleSave(desk.id).state, {
      type: "library.settled", outcome: { ok: true, value: { products: [chair], collections: [room] } },
    });
    expect(state).toMatchObject({ collectionId: null, refreshing: false });
  });

  it("Given 다시 읽는 중 When 로그인이 필요하다는 응답이면 Then 로그인으로 떠난다", () => {
    expect(transition(staleSave().state, {
      type: "library.settled", outcome: { ok: false, failure: { kind: "redirect", to: "/login" } },
    }).state).toEqual({ phase: "leaving", to: "/login" });
  });

  const staleCollection = () => run(ready({ dialog: { kind: "collection", name: "주방", saving: true, error: null } }), {
    type: "collection.settled", from: "dialog", outcome: { ok: false, failure: { kind: "stale", message: "같은 이름의 컬렉션이 이미 있어요." } },
  });

  it.each([
    ["링크를 다시 담으면", staleSave, { type: "add.submit" }],
    ["담는 중에 새 컬렉션을 만들면", staleSave, { type: "add.createCollection", name: "주방" }],
    ["컬렉션 대화상자에서 다시 만들면", staleCollection, { type: "collection.submit" }],
  ] satisfies [string, () => ReturnType<typeof run>, ScreenEvent][])(
    "Given 다시 읽는 중 When %s Then 요청하지 않고 화면을 그대로 둔다",
    (_, stale, event) => {
      const { state } = stale();
      expect(state).toMatchObject({ refreshing: true });
      expect(transition(state, event)).toEqual({ state, call: null });
    },
  );
});

describe("담는 중에 컬렉션 만들기", () => {
  it("Given 이미 있는 이름 When 대소문자·공백·정규화만 다르게 만들면 Then 요청하지 않고 그 컬렉션을 고른다", () => {
    const { state, call } = run(adding(), { type: "add.createCollection", name: "  DESK " });
    expect(call).toBeNull();
    expect(dialogOf(state)).toMatchObject({ draft: { collectionIds: [desk.id] }, creating: null });
    const composed = run(adding(), { type: "add.createCollection", name: "방" });
    expect(composed.call).toBeNull();
    expect(dialogOf(composed.state)).toMatchObject({ draft: { collectionIds: [room.id] } });
  });

  it("Given 새 이름 When 만들면 Then 정리한 이름으로 요청하고, 끝나기 전의 두 번째 만들기는 무시한다", () => {
    const first = run(adding(), { type: "add.createCollection", name: " 책상 " });
    expect(first.call).toEqual({ type: "collection.create", body: { name: "책상" }, from: "picker" });
    expect(dialogOf(first.state)).toMatchObject({ creating: "책상" });
    expect(transition(first.state, { type: "add.createCollection", name: "주방" })).toEqual({ state: first.state, call: null });
  });

  it("Given 만드는 중 When 만들어지면 Then 목록에 더하고 바로 고른다", () => {
    const created = { ...desk, id: "66666666-6666-4666-8666-666666666666", name: "책상" };
    const { state, call } = run(adding({ collectionIds: [room.id] }, { creating: "책상" }),
      { type: "collection.settled", from: "picker", outcome: { ok: true, value: created } });
    expect(call).toBeNull();
    expect(state).toMatchObject({ library: { collections: [desk, room, created] } });
    expect(dialogOf(state)).toMatchObject({ creating: null, draft: { collectionIds: [room.id, created.id] }, error: null });
  });

  it("Given 만드는 중 When 닫고 다시 열어 다른 이름을 만들면 Then 모두 무시하고, 만들어지면 처음 대화상자에서 고른다", () => {
    const created = { ...desk, id: "66666666-6666-4666-8666-666666666666", name: "책상" };
    const creating = run(ready(), { type: "add.open" }, { type: "add.edit", url: "https://shop.example/lamp" },
      { type: "add.createCollection", name: "책상" });
    for (const event of [
      { type: "dialog.close" },
      { type: "add.open" },
      { type: "collection.open" },
      { type: "detail.open", productId: lamp.id },
    ] satisfies ScreenEvent[]) {
      expect(transition(creating.state, event)).toEqual({ state: creating.state, call: null });
    }
    const reopened = run(creating.state, { type: "dialog.close" }, { type: "add.open" }, { type: "add.createCollection", name: "주방" });
    expect(reopened).toEqual({ state: creating.state, call: null });
    const { state, call } = transition(reopened.state, {
      type: "collection.settled", from: "picker", outcome: { ok: true, value: created },
    });
    expect(call).toBeNull();
    expect(state).toEqual(ready({
      library: { ...library, collections: [desk, room, created] },
      dialog: {
        kind: "add",
        draft: { url: "https://shop.example/lamp", option: "", collectionIds: [created.id] },
        saving: false,
        creating: null,
        error: null,
      },
    }));
  });

  it("Given 만드는 중 When 실패하면 Then 컬렉션 칸 아래에 오류를 보여주고, 이름 중복이면 보관함을 다시 읽는다", () => {
    const failed = run(adding({}, { creating: "책상" }), { type: "collection.settled", from: "picker", outcome: { ok: false, failure: unavailable } });
    expect(failed.call).toBeNull();
    expect(dialogOf(failed.state)).toMatchObject({ creating: null, error: { field: "collection", message: unavailable.message } });
    const stale = run(adding({}, { creating: "책상" }), {
      type: "collection.settled", from: "picker", outcome: { ok: false, failure: { kind: "stale", message: "같은 이름의 컬렉션이 이미 있어요." } },
    });
    expect(stale.call).toEqual({ type: "library.read" });
    expect(stale.state).toMatchObject({ refreshing: true });
    expect(dialogOf(stale.state)).toMatchObject({ creating: null, error: { field: "collection", message: "같은 이름의 컬렉션이 이미 있어요." } });
  });

  it("Given 이름 규칙에 맞지 않는 이름 When 만들면 Then 요청하지 않고 컬렉션 칸에 규칙의 문구를 보여준다", () => {
    const { state, call } = run(adding(), { type: "add.createCollection", name: "가".repeat(41) });
    expect(call).toBeNull();
    expect(dialogOf(state)).toMatchObject({
      creating: null, error: { field: "collection", message: "컬렉션 이름은 1~40자로 입력해 주세요." },
    });
  });
});

describe("컬렉션 대화상자", () => {
  it("Given 보관함 When 새 컬렉션 이름을 입력해 만들면 Then 저장 중이 되고 대화상자 요청을 보낸다", () => {
    const { state, call } = run(ready(), { type: "collection.open" }, { type: "collection.edit", name: " 주방 " },
      { type: "collection.submit" });
    expect(call).toEqual({ type: "collection.create", body: { name: "주방" }, from: "dialog" });
    expect(dialogOf(state)).toEqual({ kind: "collection", name: " 주방 ", saving: true, error: null });
  });

  it("Given 이미 있는 이름이나 빈 이름 When 만들면 Then 요청하지 않고 오류를 보여준다", () => {
    const duplicate = run(ready(), { type: "collection.open" }, { type: "collection.edit", name: "desk" }, { type: "collection.submit" });
    expect(duplicate.call).toBeNull();
    expect(dialogOf(duplicate.state)).toMatchObject({ saving: false, error: { field: "collection", message: "같은 이름의 컬렉션이 이미 있어요." } });
    const empty = run(ready(), { type: "collection.open" }, { type: "collection.submit" });
    expect(empty.call).toBeNull();
    expect(dialogOf(empty.state)).toMatchObject({ error: { field: "collection", message: "컬렉션 이름은 1~40자로 입력해 주세요." } });
  });

  it("Given 저장 중 When 다시 만들거나 닫으면 Then 무시한다", () => {
    const saving = ready({ dialog: { kind: "collection", name: "주방", saving: true, error: null } });
    expect(run(saving, { type: "collection.submit" })).toEqual({ state: saving, call: null });
    expect(run(saving, { type: "dialog.close" })).toEqual({ state: saving, call: null });
  });

  it("Given 저장 중 When 만들어지면 Then 대화상자를 닫고 새 컬렉션으로 거른다", () => {
    const created = { ...desk, id: "77777777-7777-4777-8777-777777777777", name: "주방" };
    const { state } = run(ready({ dialog: { kind: "collection", name: "주방", saving: true, error: null } }),
      { type: "collection.settled", from: "dialog", outcome: { ok: true, value: created } });
    expect(state).toEqual(ready({ library: { ...library, collections: [desk, room, created] }, collectionId: created.id }));
  });

  it("Given 저장 중 When 실패하면 Then 이름을 지키고 오류를 보여주며, 중복이면 보관함을 다시 읽는다", () => {
    const saving = ready({ dialog: { kind: "collection", name: "주방", saving: true, error: null } });
    const failed = run(saving, { type: "collection.settled", from: "dialog", outcome: { ok: false, failure: unavailable } });
    expect(dialogOf(failed.state)).toEqual({ kind: "collection", name: "주방", saving: false, error: { field: null, message: unavailable.message } });
    const stale = run(saving, {
      type: "collection.settled", from: "dialog", outcome: { ok: false, failure: { kind: "stale", message: "같은 이름의 컬렉션이 이미 있어요." } },
    });
    expect(stale.call).toEqual({ type: "library.read" });
    expect(dialogOf(stale.state)).toEqual({
      kind: "collection", name: "주방", saving: false, error: { field: "collection", message: "같은 이름의 컬렉션이 이미 있어요." },
    });
  });
});

describe("상세", () => {
  it("Given 보관함 When 상품을 열면 Then 도착 안내 없이 상세를 연다", () => {
    expect(dialogOf(run(ready(), { type: "detail.open", productId: lamp.id }).state))
      .toEqual({ kind: "detail", productId: lamp.id, arrival: null, error: null });
  });

  it("Given 상세를 연 상품이 사라짐 When 새 보관함을 받으면 Then 상세를 닫는다", () => {
    const open = ready({ dialog: { kind: "detail", productId: lamp.id, arrival: null, error: null }, refreshing: true });
    expect(transition(open, { type: "library.settled", outcome: { ok: true, value: { ...library, products: [chair] } } }).state)
      .toMatchObject({ dialog: null });
  });
});

describe("로그인으로 떠나기", () => {
  it("Given 어떤 대화상자 상태든 When 응답이 로그인을 요구하면 Then 로그인으로 떠난다", () => {
    const redirect = { ok: false as const, failure: { kind: "redirect" as const, to: "/login?error=forbidden" } };
    const states = [
      ready({ refreshing: true }),
      adding({}, { saving: true }),
      adding({}, { creating: "책상" }),
      ready({ dialog: { kind: "collection", name: "주방", saving: true, error: null } }),
      ready(),
    ];
    for (const state of states) {
      for (const event of [
        { type: "library.settled", outcome: redirect },
        { type: "link.settled", outcome: redirect },
        { type: "collection.settled", from: "picker", outcome: redirect },
        { type: "collection.settled", from: "dialog", outcome: redirect },
      ] satisfies ScreenEvent[]) {
        expect(transition(state, event)).toEqual({ state: { phase: "leaving", to: "/login?error=forbidden" }, call: null });
      }
    }
  });
});

describe("뒤로 가기 캐시에서 돌아온 화면", () => {
  it("Given 보관함이나 실패 안내 When 페이지가 캐시에서 다시 보이면 Then 불러오는 중으로 돌아가 보관함을 다시 요청한다", () => {
    for (const state of [
      ready(),
      ready({ collectionId: desk.id, refreshing: true }),
      adding({}, { saving: true }),
      ready({ dialog: { kind: "detail", productId: lamp.id, arrival: null, error: null } }),
      { phase: "failed", message: unavailable.message },
    ] satisfies LibraryScreenState[]) {
      expect(transition(state, { type: "resume" })).toEqual(initialScreen);
    }
  });

  it("Given 불러오는 중이거나 떠나는 중 When 페이지가 캐시에서 다시 보이면 Then 아무것도 바꾸지 않는다", () => {
    for (const state of [{ phase: "loading" }, { phase: "leaving", to: "/login" }] satisfies LibraryScreenState[]) {
      expect(transition(state, { type: "resume" })).toEqual({ state, call: null });
    }
  });
});

describe("요청 실행", () => {
  it("Given 각 요청 When 실행하면 Then 해당 API를 부르고 결과 이벤트로 돌려준다", async () => {
    const created = { ...desk, name: "주방" };
    const api: LibraryApi = {
      read: vi.fn(async () => ({ ok: true as const, value: library })),
      saveLink: vi.fn(async () => ({ ok: true as const, value: { kind: "added" as const, product: lamp } })),
      createCollection: vi.fn(async () => ({ ok: true as const, value: created })),
      retryMetadata: vi.fn(async () => ({ ok: true as const, value: { product: lamp } })),
      changeProduct: vi.fn(async () => ({ ok: true as const, value: { product: lamp } })),
    };
    await expect(perform(api, { type: "library.read" })).resolves.toEqual({ type: "library.settled", outcome: { ok: true, value: library } });
    const body = { url: "https://a.example", option: "", collectionIds: [] };
    await expect(perform(api, { type: "link.save", body }))
      .resolves.toEqual({ type: "link.settled", outcome: { ok: true, value: { kind: "added", product: lamp } } });
    expect(api.saveLink).toHaveBeenCalledWith(body);
    await expect(perform(api, { type: "collection.create", body: { name: "주방" }, from: "dialog" }))
      .resolves.toEqual({ type: "collection.settled", from: "dialog", outcome: { ok: true, value: created } });
    expect(api.createCollection).toHaveBeenCalledWith({ name: "주방" });
    await expect(perform(api, { type: "metadata.retry", productId: lamp.id, body: { generation: 1 } }))
      .resolves.toEqual({ type: "metadata.settled", productId: lamp.id, outcome: { ok: true, value: { product: lamp } } });
    expect(api.retryMetadata).toHaveBeenCalledWith(lamp.id, { generation: 1 });
    const change = { revision: 1, change: { type: "purchase" as const } };
    await expect(perform(api, { type: "product.change", productId: lamp.id, body: change }))
      .resolves.toEqual({ type: "change.settled", productId: lamp.id, intent: "purchase", outcome: { ok: true, value: { product: lamp } } });
    expect(api.changeProduct).toHaveBeenCalledWith(lamp.id, change);
    await expect(perform(api, { type: "library.poll" })).resolves.toEqual({ type: "poll.settled", outcome: { ok: true, value: library } });
    expect(api.read).toHaveBeenCalledTimes(2);
  });
});

const failedLamp: ProductResponse = { ...lamp, metadata: { phase: "failed", generation: 1, attempts: 1, errorCode: "blocked_address" } };
const readyLamp: ProductResponse = {
  ...lamp,
  title: "책상 조명",
  metadata: { phase: "ready", generation: 1, attempts: 1, completedAt: "2026-11-11T00:00:05.000Z", image: { outcome: "absent" } },
  lastSuccessfulPrice: { amountMinor: 59000, currency: "KRW", checkedAt: "2026-11-11T00:00:05.000Z" },
};
const withProducts = (products: ProductResponse[], overrides: Partial<Ready> = {}) =>
  ready({ library: { ...library, products }, ...overrides });
const settled = (products: ProductResponse[]): ScreenEvent =>
  ({ type: "poll.settled", outcome: { ok: true, value: { products, collections: library.collections } } });
const productsOf = (state: LibraryScreenState) => (state as Ready).library.products;

describe("수집 결과 기다리기", () => {
  const settledChair: ProductResponse = { ...chair, metadata: { phase: "failed", generation: 1, attempts: 1, errorCode: "timeout" } };

  it("Given 수집을 기다리는 상품 When 다음 확인 간격을 정하면 Then 점점 길게 기다리고 40번 뒤에는 멈춘다", () => {
    const state = ready();
    expect([0, 1, 2, 3, 4, 5, 20, MAX_POLLS - 1].map((polls) => pollDelay(state, polls)))
      .toEqual([1500, 2000, 3000, 5000, 8000, 8000, 8000, 8000]);
    expect(pollDelay(state, MAX_POLLS)).toBeNull();
  });

  it("Given 기다리는 상품이 없거나 멈춘 상품뿐 When 간격을 정하면 Then 확인하지 않는다", () => {
    expect(pollDelay(withProducts([readyLamp, settledChair]), 0)).toBeNull();
    const stalled: ProductResponse = { ...lamp, metadata: { phase: "running", generation: 1, attempts: 1, stalled: true } };
    expect(pollDelay(withProducts([stalled, settledChair]), 0)).toBeNull();
    expect(pollDelay({ phase: "loading" }, 0)).toBeNull();
    expect(pollDelay({ phase: "failed", message: "x" }, 0)).toBeNull();
  });

  it("Given 보관함 When 확인할 때가 되면 Then 새로고침 표시 없이 보관함을 읽는다", () => {
    expect(transition(ready(), { type: "poll" })).toEqual({ state: ready(), call: { type: "library.poll" } });
    expect(transition({ phase: "loading" }, { type: "poll" })).toEqual({ state: { phase: "loading" }, call: null });
  });

  it("Given 새 사본이 담긴 확인 결과 When 받으면 Then 사진도 반영한다", () => {
    const picture = { src: `/api/products/${lamp.id}/picture?v=77777777-7777-4777-8777-777777777777` };
    const copied: ProductResponse = {
      ...readyLamp,
      metadata: { ...readyLamp.metadata, image: { outcome: "copied" } } as ProductResponse["metadata"],
      picture,
    };
    expect(productsOf(transition(withProducts([lamp]), settled([copied])).state)[0]).toMatchObject({ picture, metadata: copied.metadata });
  });

  it("Given 확인 결과 When 받으면 Then 화면의 상품에 이름·수집 상태·가격·사진만 반영하고 다른 내용과 순서는 그대로 둔다", () => {
    const polled = { ...readyLamp, note: "다른 곳에서 고친 메모", collectionIds: [], option: "바뀐 옵션" };
    const stranger = product("66666666-6666-4666-8666-666666666666", "2026-11-12T00:00:00.000Z");
    const { state, call } = transition(ready({ dialog: { kind: "detail", productId: lamp.id, arrival: "added", error: null } }), settled([stranger, chair, polled]));
    expect(call).toBeNull();
    expect(productsOf(state)).toEqual([
      { ...lamp, title: readyLamp.title, metadata: readyLamp.metadata, lastSuccessfulPrice: readyLamp.lastSuccessfulPrice, picture: null },
      chair,
    ]);
    expect(state).toMatchObject({ refreshing: false, dialog: { kind: "detail", productId: lamp.id, arrival: "added" } });
  });

  it("Given 화면보다 이전 세대의 결과 When 받으면 Then 무시한다", () => {
    const requeued: ProductResponse = { ...lamp, metadata: { phase: "queued", generation: 2, attempts: 0, stalled: false } };
    const olderReady: ProductResponse = { ...readyLamp, metadata: { ...readyLamp.metadata, generation: 1 } };
    expect(productsOf(transition(withProducts([requeued]), settled([olderReady])).state)).toEqual([requeued]);
  });

  it("Given 같은 세대의 더 이른 단계 When 받으면 Then 무시하고, 새 세대는 단계와 무관하게 반영한다", () => {
    const running: ProductResponse = { ...lamp, metadata: { phase: "running", generation: 1, attempts: 1, stalled: false } };
    expect(productsOf(transition(withProducts([running]), settled([lamp])).state)).toEqual([running]);
    expect(productsOf(transition(withProducts([failedLamp]), settled([running])).state)).toEqual([failedLamp]);
    const next: ProductResponse = { ...lamp, metadata: { phase: "queued", generation: 2, attempts: 0, stalled: false } };
    expect(productsOf(transition(withProducts([failedLamp]), settled([next])).state)).toEqual([next]);
    const stalled: ProductResponse = { ...lamp, metadata: { phase: "running", generation: 1, attempts: 1, stalled: true } };
    expect(productsOf(transition(withProducts([running]), settled([stalled])).state)).toEqual([stalled]);
  });

  it("Given 확인이 실패 When 결과를 받으면 Then 세션 만료만 로그인으로 보내고 나머지는 화면을 그대로 둔다", () => {
    expect(transition(ready(), { type: "poll.settled", outcome: { ok: false, failure: unavailable } })).toEqual({ state: ready(), call: null });
    expect(transition(ready(), { type: "poll.settled", outcome: { ok: false, failure: { kind: "redirect", to: "/login" } } }).state)
      .toEqual({ phase: "leaving", to: "/login" });
  });
});

describe("다시 가져오기", () => {
  const detail = (productId = lamp.id): ScreenDialog => ({ kind: "detail", productId, arrival: null, error: null });
  const retrying = { productId: lamp.id, intent: "retry" as const };

  it("Given 실패한 상품의 상세 When 다시 가져오면 Then 그 세대로 요청하고 끝날 때까지 다시 누를 수 없다", () => {
    const start = withProducts([failedLamp, chair], { dialog: detail() });
    const { state, call } = transition(start, { type: "metadata.retry", productId: lamp.id });
    expect(call).toEqual({ type: "metadata.retry", productId: lamp.id, body: { generation: 1 } });
    expect(state).toMatchObject({ writing: { productId: lamp.id, intent: "retry" } });
    expect(transition(state, { type: "metadata.retry", productId: lamp.id })).toEqual({ state, call: null });
  });

  it("Given 사진을 가져오지 못한 상품 When 다시 가져오면 Then 그 세대로 요청한다", () => {
    const pictureFailed: ProductResponse = {
      ...readyLamp,
      metadata: { ...readyLamp.metadata, image: { outcome: "failed", errorCode: "timeout" } } as ProductResponse["metadata"],
    };
    expect(transition(withProducts([pictureFailed]), { type: "metadata.retry", productId: lamp.id }).call)
      .toEqual({ type: "metadata.retry", productId: lamp.id, body: { generation: 1 } });
  });

  it("Given 멈춘 작업 When 다시 가져오면 Then 같은 세대로 요청한다", () => {
    const stalled: ProductResponse = { ...lamp, metadata: { phase: "queued", generation: 3, attempts: 1, stalled: true } };
    expect(transition(withProducts([stalled]), { type: "metadata.retry", productId: lamp.id }).call)
      .toEqual({ type: "metadata.retry", productId: lamp.id, body: { generation: 3 } });
  });

  it("Given 수집 중이거나 끝났거나 없는 상품, 또는 보관함을 새로 읽는 중 When 다시 가져오면 Then 요청하지 않는다", () => {
    for (const state of [ready(), withProducts([readyLamp]), withProducts([failedLamp], { refreshing: true })]) {
      expect(transition(state, { type: "metadata.retry", productId: lamp.id })).toEqual({ state, call: null });
    }
    const missing = withProducts([failedLamp]);
    expect(transition(missing, { type: "metadata.retry", productId: chair.id })).toEqual({ state: missing, call: null });
  });

  it("Given 다시 가져오기 성공 When 결과를 받으면 Then 상품을 제자리에서 바꾸고 다시 누를 수 있다", () => {
    const requeued: ProductResponse = { ...lamp, metadata: { phase: "queued", generation: 2, attempts: 0, stalled: false } };
    const start = withProducts([chair, failedLamp], { dialog: detail(), writing: retrying });
    const { state, call } = transition(start, { type: "metadata.settled", productId: lamp.id, outcome: { ok: true, value: { product: requeued } } });
    expect(call).toBeNull();
    expect(state).toMatchObject({ writing: null, dialog: detail() });
    expect(productsOf(state)).toEqual([chair, requeued]);
  });

  it("Given 멈춰서 확인을 멈춘 상품 When 같은 세대로 다시 시작되면 Then 다시 확인한다", () => {
    const stalled: ProductResponse = { ...lamp, metadata: { phase: "running", generation: 1, attempts: 1, stalled: true } };
    const resumed: ProductResponse = { ...lamp, metadata: { phase: "queued", generation: 1, attempts: 1, stalled: false } };
    const start = withProducts([stalled], { writing: retrying });
    expect(pollDelay(start, 0)).toBeNull();

    const { state } = transition(start, { type: "metadata.settled", productId: lamp.id, outcome: { ok: true, value: { product: resumed } } });

    expect(pollDelay(state, 0)).toBe(1500);
  });

  it("Given 상태가 바뀌어 거절 When 결과를 받으면 Then 안내하고 보관함을 새로 읽는다", () => {
    const start = withProducts([failedLamp], { dialog: detail(), writing: retrying });
    const failure: ApiFailure = { kind: "stale", message: "상품 상태가 바뀌었어요. 목록을 새로 불러왔어요." };
    const { state, call } = transition(start, { type: "metadata.settled", productId: lamp.id, outcome: { ok: false, failure } });
    expect(call).toEqual({ type: "library.read" });
    expect(state).toMatchObject({ writing: null, refreshing: true, dialog: { ...detail(), error: failure.message } });
  });

  it("Given 일시적 실패 When 결과를 받으면 Then 상세에 안내하고 다시 누를 수 있게 한다", () => {
    const start = withProducts([failedLamp], { dialog: detail(), writing: retrying });
    const { state, call } = transition(start, { type: "metadata.settled", productId: lamp.id, outcome: { ok: false, failure: unavailable } });
    expect(call).toBeNull();
    expect(state).toEqual({ ...start, writing: null, dialog: { ...detail(), error: unavailable.message } });
    expect(transition(state, { type: "metadata.retry", productId: lamp.id }).state).toMatchObject({ writing: retrying, dialog: detail() });
  });

  it("Given 세션 만료 When 결과를 받으면 Then 로그인으로 보낸다", () => {
    const start = withProducts([failedLamp], { writing: retrying });
    expect(transition(start, { type: "metadata.settled", productId: lamp.id, outcome: { ok: false, failure: { kind: "redirect", to: "/login" } } }).state)
      .toEqual({ phase: "leaving", to: "/login" });
  });
});

const purchasedLamp: ProductResponse = { ...lamp, revision: 2, purchase: { status: "purchased", date: null, price: null } };
const changed = (product: ProductResponse, intent: "details" | "purchase" | "purchase.record" | "wish" = "purchase"): ScreenEvent =>
  ({ type: "change.settled", productId: product.id, intent, outcome: { ok: true, value: { product } } });
const failedChange = (failure: ApiFailure, intent: "purchase" | "wish" = "purchase"): ScreenEvent =>
  ({ type: "change.settled", productId: lamp.id, intent, outcome: { ok: false, failure } });
const purchasing = { productId: lamp.id, intent: "purchase" as const };

describe("위시와 구매완료 보기", () => {
  it("Given 위시와 구매한 상품 When 보기를 고르면 Then 그 상태의 상품만 컬렉션 필터와 함께 보여준다", () => {
    const products = { ...library, products: [purchasedLamp, chair] };
    expect(visibleProducts(products, "wish", null)).toEqual([chair]);
    expect(visibleProducts(products, "purchased", null)).toEqual([purchasedLamp]);
    expect(visibleProducts(products, "purchased", desk.id)).toEqual([purchasedLamp]);
    expect(visibleProducts(products, "purchased", room.id)).toEqual([]);
  });

  it("Given 위시 보기 When 구매완료 보기로 바꾸면 Then 컬렉션 필터는 그대로 두고 알림을 닫는다", () => {
    const start = ready({ collectionId: desk.id, toast: { kind: "notice", message: "위시리스트로 되돌렸어요" } });
    expect(transition(start, { type: "view", view: "purchased" })).toEqual({
      state: ready({ collectionId: desk.id, view: "purchased" }), call: null,
    });
  });
});

describe("상품을 화면에 합치기", () => {
  const readyLampAt = (revision: number, note = lamp.note): ProductResponse => ({ ...readyLamp, revision, note });

  it("Given 화면의 상품 When 더 높은 revision을 받으면 Then 소유자가 바꾼 값까지 모두 바꾼다", () => {
    expect(mergeProduct(lamp, readyLampAt(2, "다른 곳에서 쓴 메모"))).toEqual(readyLampAt(2, "다른 곳에서 쓴 메모"));
  });

  it("Given 방금 저장한 상품 When 저장 전에 읽은 더 낮은 revision을 받으면 Then 수집 결과가 앞서도 무시한다", () => {
    const saved = { ...lamp, revision: 3, note: "방금 저장한 메모", title: "내가 고친 이름" };
    expect(mergeProduct(saved, readyLampAt(2))).toBe(saved);
  });

  it("Given 같은 revision When 받으면 Then 앞선 수집 결과만 반영하고 소유자 값은 바꾸지 않는다", () => {
    const merged = mergeProduct(lamp, readyLampAt(1, "같은 revision의 다른 메모"));
    expect(merged).toEqual({ ...lamp, title: readyLamp.title, metadata: readyLamp.metadata, lastSuccessfulPrice: readyLamp.lastSuccessfulPrice, picture: null });
  });

  it("Given 방금 저장한 상품 When 저장 전에 시작한 확인 결과가 오면 Then 이름·수집 상태를 되돌리지 않는다", () => {
    const saved = { ...lamp, revision: 2, title: "내가 고친 이름" };
    expect(productsOf(transition(withProducts([saved]), settled([readyLampAt(1)])).state)).toEqual([saved]);
  });

  it("Given 다시 읽기 When 상품마다 revision을 비교하면 Then 높은 것은 바꾸고 낮은 것은 화면 값을 지킨다", () => {
    const saved = { ...chair, revision: 3, note: "방금 저장" };
    const { state } = transition(withProducts([lamp, saved], { refreshing: true }), {
      type: "library.settled",
      outcome: { ok: true, value: { products: [readyLampAt(2, "다른 곳"), { ...chair, revision: 2 }], collections: library.collections } },
    });
    expect(productsOf(state)).toEqual([readyLampAt(2, "다른 곳"), saved]);
  });
});

describe("구매완료와 실행 취소", () => {
  it("Given 위시 상품 When 카드에서 구매완료로 옮기면 Then 화면이 본 revision으로 요청하고 끝날 때까지 다른 쓰기를 막는다", () => {
    const start = ready({ toast: { kind: "notice", message: "이전 알림" } });
    const { state, call } = transition(start, { type: "product.purchase", productId: lamp.id });
    expect(call).toEqual({ type: "product.change", productId: lamp.id, body: { revision: 1, change: { type: "purchase" } } });
    expect(state).toEqual(ready({ writing: purchasing }));
    for (const event of [
      { type: "product.purchase", productId: lamp.id },
      { type: "product.purchase", productId: chair.id },
      { type: "metadata.retry", productId: lamp.id },
    ] satisfies ScreenEvent[]) {
      expect(transition(state, event)).toEqual({ state, call: null });
    }
  });

  it("Given 이미 구매한 상품이거나 보관함을 새로 읽는 중 When 구매완료로 옮기면 Then 요청하지 않는다", () => {
    for (const state of [withProducts([purchasedLamp]), ready({ refreshing: true })]) {
      expect(transition(state, { type: "product.purchase", productId: lamp.id })).toEqual({ state, call: null });
    }
  });

  it("Given 구매 요청 중 When 성공하면 Then 상품을 구매완료로 바꾸고 그 revision의 실행 취소 알림을 띄운다", () => {
    const { state, call } = transition(ready({ writing: purchasing }), changed(purchasedLamp));
    expect(call).toBeNull();
    expect(state).toEqual(ready({
      library: { ...library, products: [purchasedLamp, chair] },
      toast: { kind: "purchased", productId: lamp.id, revision: 2 },
    }));
    expect(visibleToast(state as Ready)).toEqual({ message: "구매완료 목록으로 옮겼어요", undo: true });
    expect(visibleProducts((state as Ready).library, "wish", null)).toEqual([chair]);
  });

  it("Given 구매완료 알림 When 실행 취소하면 Then 알림의 revision으로 위시로 되돌리기를 요청하고, 끝나면 되돌렸다고 알린다", () => {
    const start = withProducts([purchasedLamp, chair], { toast: { kind: "purchased", productId: lamp.id, revision: 2 } });
    const undo = transition(start, { type: "toast.undo" });
    expect(undo.call).toEqual({ type: "product.change", productId: lamp.id, body: { revision: 2, change: { type: "wish" } } });
    expect(undo.state).toMatchObject({ writing: { productId: lamp.id, intent: "wish" }, toast: null });
    expect(transition(undo.state, { type: "toast.undo" })).toEqual({ state: undo.state, call: null });

    const wish = { ...lamp, revision: 3 };
    const { state } = transition(undo.state, changed(wish, "wish"));
    expect(state).toMatchObject({ writing: null, toast: { kind: "notice", message: "위시리스트로 되돌렸어요" } });
    expect(productsOf(state)).toEqual([wish, chair]);
  });

  it("Given 구매완료 알림 뒤 상품이 다시 바뀜 When 알림을 보거나 실행 취소하면 Then 알림을 숨기고 요청하지 않는다", () => {
    const moved = withProducts([{ ...purchasedLamp, revision: 3 }], { toast: { kind: "purchased", productId: lamp.id, revision: 2 } });
    expect(visibleToast(moved)).toBeNull();
    expect(transition(moved, { type: "toast.undo" })).toEqual({ state: moved, call: null });
  });

  it("Given 다른 곳에서 먼저 바뀐 상품 When 구매 요청이 거절되면 Then 이유를 알리고 보관함을 새로 읽는다", () => {
    const failure: ApiFailure = { kind: "stale", message: "다른 곳에서 먼저 바뀌었어요. 최신 내용을 불러왔어요. 확인 후 다시 저장해 주세요." };
    const { state, call } = transition(ready({ writing: purchasing }), failedChange(failure));
    expect(call).toEqual({ type: "library.read" });
    expect(state).toEqual(ready({ refreshing: true, toast: { kind: "notice", message: failure.message } }));
  });

  it("Given 구매 요청 중 When 일시적으로 실패하거나 세션이 끝나면 Then 알리고 다시 누를 수 있게 하거나 로그인으로 보낸다", () => {
    expect(transition(ready({ writing: purchasing }), failedChange(unavailable)))
      .toEqual({ state: ready({ toast: { kind: "notice", message: unavailable.message } }), call: null });
    expect(transition(ready({ writing: purchasing }), failedChange({ kind: "redirect", to: "/login" })).state)
      .toEqual({ phase: "leaving", to: "/login" });
  });

  it("Given 알림 When 닫거나 필터·대화상자를 바꾸면 Then 알림을 닫는다", () => {
    const toast = { kind: "notice" as const, message: "위시리스트로 되돌렸어요" };
    for (const event of [
      { type: "toast.dismiss" },
      { type: "filter", collectionId: desk.id },
      { type: "add.open" },
      { type: "collection.open" },
      { type: "detail.open", productId: lamp.id },
    ] satisfies ScreenEvent[]) {
      expect(transition(ready({ toast }), event).state).toMatchObject({ toast: null });
    }
  });

  it("Given 알림 When 대화상자가 열려 있으면 Then 보이지 않는다", () => {
    const toast = { kind: "notice" as const, message: "위시리스트로 되돌렸어요" };
    expect(visibleToast(ready({ toast }))).toEqual({ message: toast.message, undo: false });
    expect(visibleToast(ready({ toast, dialog: { kind: "detail", productId: lamp.id, arrival: null, error: null } }))).toBeNull();
  });
});
