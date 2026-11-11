import { describe, expect, it, vi } from "vitest";
import type { CollectionResponse, LibraryReadResponse, ProductResponse } from "../presentation/library-dto";
import type { ApiFailure, LibraryApi } from "./library-api";
import {
  initialScreen,
  perform,
  transition,
  visibleProducts,
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
    metadata: { phase: "queued", generation: 1, attempts: 0 },
    lastSuccessfulPrice: null,
  };
}

const lamp = product("22222222-2222-4222-8222-222222222222", "2026-11-10T00:00:00.000Z", [desk.id]);
const chair = product("44444444-4444-4444-8444-444444444444", "2026-11-11T00:00:00.000Z");
const library: LibraryReadResponse = { products: [lamp, chair], collections: [desk, room] };
const unavailable: ApiFailure = { kind: "unavailable", message: "잠시 뒤 다시 시도해 주세요." };

type Ready = Extract<LibraryScreenState, { phase: "ready" }>;

function ready(overrides: Partial<Ready> = {}): Ready {
  return { phase: "ready", library, collectionId: null, dialog: null, refreshing: false, ...overrides };
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
    expect(visibleProducts({ ...library, products: [lamp, chair, twin] }, null).map((item) => item.id))
      .toEqual([twin.id, chair.id, lamp.id]);
  });

  it("Given 컬렉션 필터 When 보이는 상품을 고르면 Then 그 컬렉션의 상품만 보여준다", () => {
    expect(visibleProducts(library, desk.id)).toEqual([lamp]);
    expect(visibleProducts(library, room.id)).toEqual([]);
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
      dialog: { kind: "detail", productId: added.id, arrival: "added" },
    }));
  });

  it("Given 저장 중 When 이미 담은 상품이라는 응답이면 Then 같은 상품을 바꿔 넣고 중복 안내 상세를 연다", () => {
    const updated = { ...lamp, revision: 2 };
    const { state } = run(adding({}, { saving: true }),
      { type: "link.settled", outcome: { ok: true, value: { kind: "duplicate", product: updated } } });
    expect(state).toEqual(ready({
      library: { ...library, products: [updated, chair] },
      dialog: { kind: "detail", productId: lamp.id, arrival: "duplicate" },
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
      .toEqual({ kind: "detail", productId: lamp.id, arrival: null });
  });

  it("Given 상세를 연 상품이 사라짐 When 새 보관함을 받으면 Then 상세를 닫는다", () => {
    const open = ready({ dialog: { kind: "detail", productId: lamp.id, arrival: null }, refreshing: true });
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

describe("요청 실행", () => {
  it("Given 각 요청 When 실행하면 Then 해당 API를 부르고 결과 이벤트로 돌려준다", async () => {
    const created = { ...desk, name: "주방" };
    const api: LibraryApi = {
      read: vi.fn(async () => ({ ok: true as const, value: library })),
      saveLink: vi.fn(async () => ({ ok: true as const, value: { kind: "added" as const, product: lamp } })),
      createCollection: vi.fn(async () => ({ ok: true as const, value: created })),
    };
    await expect(perform(api, { type: "library.read" })).resolves.toEqual({ type: "library.settled", outcome: { ok: true, value: library } });
    const body = { url: "https://a.example", option: "", collectionIds: [] };
    await expect(perform(api, { type: "link.save", body }))
      .resolves.toEqual({ type: "link.settled", outcome: { ok: true, value: { kind: "added", product: lamp } } });
    expect(api.saveLink).toHaveBeenCalledWith(body);
    await expect(perform(api, { type: "collection.create", body: { name: "주방" }, from: "dialog" }))
      .resolves.toEqual({ type: "collection.settled", from: "dialog", outcome: { ok: true, value: created } });
    expect(api.createCollection).toHaveBeenCalledWith({ name: "주방" });
  });
});
