import { describe, expect, it, vi } from "vitest";
import type { WorkerRunResponse } from "../../worker/presentation/worker-dto";
import type { KeyPanel } from "./key-panel-state";
import type { CollectionResponse, LibraryReadResponse, ProductResponse } from "../presentation/library-dto";
import type { ApiFailure, LibraryApi } from "./library-api";
import {
  detailForms,
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
    priceCheck: null,
    picture: null,
  };
}

const lamp = product("22222222-2222-4222-8222-222222222222", "2026-11-10T00:00:00.000Z", [desk.id]);
const chair = product("44444444-4444-4444-8444-444444444444", "2026-11-11T00:00:00.000Z");
const library: LibraryReadResponse = { products: [lamp, chair], collections: [desk, room] };
const unavailable: ApiFailure = { kind: "unavailable", message: "잠시 뒤 다시 시도해 주세요." };
const shareKey = {
  id: "55555555-5555-4555-8555-555555555555",
  hint: "a1B2",
  createdAt: "2026-11-13T05:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
};
const shareSecret = `moti_sk_${"AbcdEfghIjklMnopQrstUvwxYz0123456789-_Aa1B2"}`;
const workerKey = { ...shareKey, id: "77777777-7777-4777-8777-777777777777", hint: "Wk9_" };
const workerSecret = `moti_wk_${"AbcdEfghIjklMnopQrstUvwxYz0123456789-_AWk9_"}`;
const workerRun: WorkerRunResponse = {
  id: "88888888-8888-4888-8888-888888888888",
  startedAt: "2026-11-13T05:17:00.000Z",
  finishedAt: "2026-11-13T05:17:40.000Z",
  state: "cut",
  collections: { collected: 1, failed: 0 },
  prices: { confirmed: 0, kept: 0 },
  failures: {},
};

type Ready = Extract<LibraryScreenState, { phase: "ready" }>;

function ready(overrides: Partial<Ready> = {}): Ready {
  return {
    phase: "ready", library, view: "wish", collectionId: null, dialog: null, refreshing: false, writing: null, toast: null,
    share: { status: "unread" }, worker: { panel: { status: "unread" }, runs: [] }, ...overrides,
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
    expect(call).toEqual({ type: "metadata.wake" });
  });

  it("Given 예약 실행이 사진을 남겨 둔 상품 When 보관함을 받으면 Then 사진을 가져오도록 깨운다", () => {
    const waiting = {
      ...library,
      products: [{
        ...lamp,
        metadata: { phase: "ready" as const, generation: 1, attempts: 1, completedAt: "2026-11-13T05:17:30.000Z", image: { outcome: "waiting" as const } },
      }],
    };
    expect(transition({ phase: "loading" }, { type: "library.settled", outcome: { ok: true, value: waiting } }).call).toEqual({ type: "metadata.wake" });
    const copied = { ...waiting, products: [{ ...waiting.products[0], metadata: { ...waiting.products[0].metadata, image: { outcome: "copied" as const } } }] };
    expect(transition({ phase: "loading" }, { type: "library.settled", outcome: { ok: true, value: copied } }).call).toBeNull();
  });

  it("Given 아직 수집을 시작하지 않은 상품이 없음 When 보관함을 받으면 Then 깨우지 않는다", () => {
    const started = { ...library, products: [{ ...lamp, metadata: { phase: "running" as const, generation: 1, attempts: 1, stalled: false } }] };
    const { state, call } = transition({ phase: "loading" }, { type: "library.settled", outcome: { ok: true, value: started } });
    expect(state).toEqual(ready({ library: started }));
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
      dialog: { kind: "detail", productId: added.id, arrival: "added", draft: {}, notice: null },
    }));
  });

  it("Given 저장 중 When 이미 담은 상품이라는 응답이면 Then 같은 상품을 바꿔 넣고 중복 안내 상세를 연다", () => {
    const updated = { ...lamp, revision: 2 };
    const { state } = run(adding({}, { saving: true }),
      { type: "link.settled", outcome: { ok: true, value: { kind: "duplicate", product: updated } } });
    expect(state).toEqual(ready({
      library: { ...library, products: [updated, chair] },
      dialog: { kind: "detail", productId: lamp.id, arrival: "duplicate", draft: {}, notice: null },
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

  const staleCollection = () => run(ready({ dialog: { kind: "collection", renaming: null, name: "주방", saving: true, error: null } }), {
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
    expect(dialogOf(state)).toEqual({ kind: "collection", renaming: null, name: " 주방 ", saving: true, error: null });
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
    const saving = ready({ dialog: { kind: "collection", renaming: null, name: "주방", saving: true, error: null } });
    expect(run(saving, { type: "collection.submit" })).toEqual({ state: saving, call: null });
    expect(run(saving, { type: "dialog.close" })).toEqual({ state: saving, call: null });
  });

  it("Given 저장 중 When 만들어지면 Then 대화상자를 닫고 새 컬렉션으로 거른다", () => {
    const created = { ...desk, id: "77777777-7777-4777-8777-777777777777", name: "주방" };
    const { state } = run(ready({ dialog: { kind: "collection", renaming: null, name: "주방", saving: true, error: null } }),
      { type: "collection.settled", from: "dialog", outcome: { ok: true, value: created } });
    expect(state).toEqual(ready({ library: { ...library, collections: [desk, room, created] }, collectionId: created.id }));
  });

  it("Given 저장 중 When 실패하면 Then 이름을 지키고 오류를 보여주며, 중복이면 보관함을 다시 읽는다", () => {
    const saving = ready({ dialog: { kind: "collection", renaming: null, name: "주방", saving: true, error: null } });
    const failed = run(saving, { type: "collection.settled", from: "dialog", outcome: { ok: false, failure: unavailable } });
    expect(dialogOf(failed.state)).toEqual({ kind: "collection", renaming: null, name: "주방", saving: false, error: { field: null, message: unavailable.message } });
    const stale = run(saving, {
      type: "collection.settled", from: "dialog", outcome: { ok: false, failure: { kind: "stale", message: "같은 이름의 컬렉션이 이미 있어요." } },
    });
    expect(stale.call).toEqual({ type: "library.read" });
    expect(dialogOf(stale.state)).toEqual({
      kind: "collection", renaming: null, name: "주방", saving: false, error: { field: "collection", message: "같은 이름의 컬렉션이 이미 있어요." },
    });
  });
});

describe("상세", () => {
  it("Given 보관함 When 상품을 열면 Then 도착 안내 없이 상세를 연다", () => {
    expect(dialogOf(run(ready(), { type: "detail.open", productId: lamp.id }).state))
      .toEqual({ kind: "detail", productId: lamp.id, arrival: null, draft: {}, notice: null });
  });

  it("Given 상세를 연 상품이 사라짐 When 새 보관함을 받으면 Then 상세를 닫는다", () => {
    const open = ready({ dialog: { kind: "detail", productId: lamp.id, arrival: null, draft: {}, notice: null }, refreshing: true });
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
      ready({ dialog: { kind: "collection", renaming: null, name: "주방", saving: true, error: null } }),
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
      ready({ dialog: { kind: "detail", productId: lamp.id, arrival: null, draft: {}, notice: null } }),
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
      renameCollection: vi.fn(async () => ({ ok: true as const, value: { ...desk, name: "작업 공간", revision: 2 } })),
      exportBackup: vi.fn(async () => ({ ok: false as const, failure: unavailable })),
      restore: vi.fn(async () => ({ ok: true as const, value: library })),
      wake: vi.fn(async () => ({ ok: true as const, value: { products: [lamp] } })),
      readShareKey: vi.fn(async () => ({ ok: true as const, value: { key: null } })),
      issueShareKey: vi.fn(async () => ({ ok: true as const, value: { key: shareKey, secret: shareSecret } })),
      revokeShareKey: vi.fn(async () => ({ ok: true as const, value: { key: { ...shareKey, revokedAt: "2026-11-13T06:00:00.000Z" } } })),
      readWorker: vi.fn(async () => ({ ok: true as const, value: { key: null, runs: [] } })),
      issueWorkerKey: vi.fn(async () => ({ ok: true as const, value: { key: workerKey, secret: workerSecret } })),
      revokeWorkerKey: vi.fn(async () => ({ ok: true as const, value: { key: { ...workerKey, revokedAt: "2026-11-13T06:00:00.000Z" } } })),
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
    await expect(perform(api, { type: "collection.rename", collectionId: desk.id, body: { revision: 1, name: "작업 공간" } }))
      .resolves.toEqual({ type: "rename.settled", outcome: { ok: true, value: { ...desk, name: "작업 공간", revision: 2 } } });
    expect(api.renameCollection).toHaveBeenCalledWith(desk.id, { revision: 1, name: "작업 공간" });
    await expect(perform(api, { type: "library.poll" })).resolves.toEqual({ type: "poll.settled", outcome: { ok: true, value: library } });
    expect(api.read).toHaveBeenCalledTimes(2);
    await expect(perform(api, { type: "metadata.wake" })).resolves.toEqual({ type: "wake.settled", outcome: { ok: true, value: { products: [lamp] } } });
    expect(api.wake).toHaveBeenCalledOnce();
    await expect(perform(api, { type: "key.read", endpoint: "share" })).resolves.toEqual({ type: "key.read.settled", endpoint: "share", outcome: { ok: true, value: { key: null } } });
    await expect(perform(api, { type: "key.issue", endpoint: "share", replaces: null }))
      .resolves.toEqual({ type: "key.issue.settled", endpoint: "share", outcome: { ok: true, value: { key: shareKey, secret: shareSecret } } });
    expect(api.issueShareKey).toHaveBeenCalledWith({ replaces: null });
    await expect(perform(api, { type: "key.revoke", endpoint: "share", keyId: shareKey.id })).resolves.toMatchObject({ type: "key.revoke.settled", endpoint: "share" });
    expect(api.revokeShareKey).toHaveBeenCalledWith(shareKey.id);
    await expect(perform(api, { type: "key.read", endpoint: "worker" }))
      .resolves.toEqual({ type: "key.read.settled", endpoint: "worker", outcome: { ok: true, value: { key: null, runs: [] } } });
    await expect(perform(api, { type: "key.issue", endpoint: "worker", replaces: null }))
      .resolves.toEqual({ type: "key.issue.settled", endpoint: "worker", outcome: { ok: true, value: { key: workerKey, secret: workerSecret } } });
    expect(api.issueWorkerKey).toHaveBeenCalledWith({ replaces: null });
    await expect(perform(api, { type: "key.revoke", endpoint: "worker", keyId: workerKey.id })).resolves.toMatchObject({ type: "key.revoke.settled", endpoint: "worker" });
    expect(api.revokeWorkerKey).toHaveBeenCalledWith(workerKey.id);
    expect(api.readShareKey).toHaveBeenCalledOnce();
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
    const { state, call } = transition(ready({ dialog: { kind: "detail", productId: lamp.id, arrival: "added", draft: {}, notice: null } }), settled([stranger, chair, polled]));
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
  const detail = (productId = lamp.id): ScreenDialog => ({ kind: "detail", productId, arrival: null, draft: {}, notice: null });
  const retrying = { productId: lamp.id, intent: "retry" as const };
  const retryError = (message: string) => ({ form: "retry" as const, kind: "error" as const, field: null, message });

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
    expect(state).toMatchObject({ writing: null, refreshing: true, dialog: { ...detail(), notice: retryError(failure.message) } });
  });

  it("Given 일시적 실패 When 결과를 받으면 Then 상세에 안내하고 다시 누를 수 있게 한다", () => {
    const start = withProducts([failedLamp], { dialog: detail(), writing: retrying });
    const { state, call } = transition(start, { type: "metadata.settled", productId: lamp.id, outcome: { ok: false, failure: unavailable } });
    expect(call).toBeNull();
    expect(state).toEqual({ ...start, writing: null, dialog: { ...detail(), notice: retryError(unavailable.message) } });
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

  it("Given 같은 revision의 수집이 끝난 상품 When 예약 실행이 가격을 확인한 뒤 읽은 결과를 받으면 Then 가격과 그 확인을 함께 반영한다", () => {
    const checked: ProductResponse = {
      ...readyLamp,
      lastSuccessfulPrice: { amountMinor: 59000, currency: "KRW", checkedAt: "2026-11-11T00:00:05.000Z" },
      priceCheck: { checkedAt: "2026-11-14T05:17:03.000Z", code: "timeout" },
    };
    expect(mergeProduct(readyLamp, checked)).toEqual(checked);
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
    expect(visibleToast(ready({ toast, dialog: { kind: "detail", productId: lamp.id, arrival: null, draft: {}, notice: null } }))).toBeNull();
  });
});

type Detail = Extract<ScreenDialog, { kind: "detail" }>;
const today = "2026-11-13";
const opened = (overrides: Partial<Detail> = {}, productId = lamp.id): Detail =>
  ({ kind: "detail", productId, arrival: null, draft: {}, notice: null, ...overrides });
const detailOf = (state: LibraryScreenState) => dialogOf(state) as Detail;
const conflict: ApiFailure = { kind: "stale", message: "다른 곳에서 먼저 바뀌었어요. 최신 내용을 불러왔어요. 확인 후 다시 저장해 주세요." };

describe("상세에서 이름·메모·컬렉션 고치기", () => {
  it("Given 상세 When 고친 칸만 초안에 남기고 Then 나머지 칸은 화면의 상품을 따른다", () => {
    const { state } = run(ready({ dialog: opened() }), { type: "detail.edit", field: "note", value: "선물용" },
      { type: "detail.toggle", collectionId: room.id });
    expect(detailOf(state).draft).toEqual({ note: "선물용", collectionIds: [desk.id, room.id] });

    const collected = transition(state, settled([readyLamp, chair])).state;
    expect(detailForms(productsOf(collected)[0], detailOf(collected).draft)).toMatchObject({
      title: readyLamp.title, note: "선물용", collectionIds: [desk.id, room.id], detailsChanged: true, recordChanged: false,
    });
  });

  it("Given 고친 이름·메모·컬렉션 When 저장하면 Then 화면이 본 revision으로 정리한 값을 보내고, 이름을 고치지 않았으면 이름은 보내지 않는다", () => {
    const named = run(ready({ dialog: opened() }), { type: "detail.edit", field: "title", value: "  책상 조명 " },
      { type: "detail.save", form: "details", today });
    expect(named.call).toEqual({
      type: "product.change", productId: lamp.id,
      body: { revision: 1, change: { type: "details", title: "책상 조명", note: "", collectionIds: [desk.id] } },
    });
    expect(named.state).toMatchObject({ writing: { productId: lamp.id, intent: "details" } });

    const noted = run(ready({ dialog: opened() }), { type: "detail.edit", field: "note", value: "메모" },
      { type: "detail.toggle", collectionId: desk.id }, { type: "detail.save", form: "details", today });
    expect(noted.call).toMatchObject({ body: { change: { type: "details", title: null, note: "메모", collectionIds: [] } } });
  });

  it("Given 규칙에 맞지 않는 이름이나 메모 When 저장하면 Then 요청하지 않고 그 칸에 오류를 보여준다", () => {
    const title = run(ready({ dialog: opened() }), { type: "detail.edit", field: "title", value: "  " }, { type: "detail.save", form: "details", today });
    expect(title.call).toBeNull();
    expect(detailOf(title.state).notice).toEqual({ form: "details", kind: "error", field: "title", message: "상품 이름은 1~120자로 입력해 주세요." });
    const note = run(ready({ dialog: opened() }), { type: "detail.edit", field: "note", value: "가".repeat(3001) }, { type: "detail.save", form: "details", today });
    expect(note.call).toBeNull();
    expect(detailOf(note.state).notice).toMatchObject({ field: "note", message: "메모는 3,000자까지 적을 수 있어요." });
  });

  it("Given 정리하면 지금과 같은 값 When 저장하면 Then 요청하지 않고 초안을 비운다", () => {
    const { state, call } = run(ready({ dialog: opened() }), { type: "detail.edit", field: "title", value: " 새로 담은 상품 " },
      { type: "detail.edit", field: "price", value: "1000" }, { type: "detail.save", form: "details", today });
    expect(call).toBeNull();
    expect(detailOf(state).draft).toEqual({ price: "1000" });
  });

  it("Given 저장 중 When 고치거나 다시 저장하거나 닫으면 Then 무시한다", () => {
    const saving = ready({ dialog: opened({ draft: { note: "메모" } }), writing: { productId: lamp.id, intent: "details" } });
    for (const event of [
      { type: "detail.edit", field: "note", value: "또" },
      { type: "detail.toggle", collectionId: room.id },
      { type: "detail.save", form: "details", today },
      { type: "dialog.close" },
    ] satisfies ScreenEvent[]) {
      expect(transition(saving, event)).toEqual({ state: saving, call: null });
    }
  });

  it("Given 저장 중 When 성공하면 Then 상품을 바꾸고 이 양식의 초안만 비우며 저장했다고 알린다", () => {
    const saved = { ...lamp, revision: 2, note: "메모" };
    const start = ready({ dialog: opened({ draft: { note: "메모", date: "2026-11-01" } }), writing: { productId: lamp.id, intent: "details" } });
    const { state } = transition(start, { type: "change.settled", productId: lamp.id, intent: "details", outcome: { ok: true, value: { product: saved } } });
    expect(productsOf(state)[0]).toEqual(saved);
    expect(state).toMatchObject({ writing: null });
    expect(detailOf(state)).toEqual(opened({
      draft: { date: "2026-11-01" }, notice: { form: "details", kind: "saved", field: null, message: "변경사항을 저장했어요" },
    }));
  });

  it("Given 다른 곳에서 먼저 바뀜 When 저장이 거절되면 Then 안내하고 다시 읽은 뒤 고친 칸은 지키고 다음 저장은 새 revision으로 보낸다", () => {
    const start = ready({ dialog: opened({ draft: { note: "내 메모" } }), writing: { productId: lamp.id, intent: "details" } });
    const rejected = transition(start, { type: "change.settled", productId: lamp.id, intent: "details", outcome: { ok: false, failure: conflict } });
    expect(rejected.call).toEqual({ type: "library.read" });
    expect(rejected.state).toMatchObject({ refreshing: true, writing: null });
    expect(detailOf(rejected.state).notice).toEqual({ form: "details", kind: "error", field: null, message: conflict.message });

    const elsewhere = { ...lamp, revision: 2, title: "다른 곳의 이름", note: "다른 곳의 메모" };
    const reread = transition(rejected.state, { type: "library.settled", outcome: { ok: true, value: { ...library, products: [elsewhere, chair] } } });
    expect(detailOf(reread.state).draft).toEqual({ note: "내 메모" });
    expect(detailForms(productsOf(reread.state)[0], detailOf(reread.state).draft)).toMatchObject({ title: "다른 곳의 이름", note: "내 메모" });
    expect(transition(reread.state, { type: "detail.save", form: "details", today }).call).toMatchObject({
      body: { revision: 2, change: { type: "details", title: null, note: "내 메모" } },
    });
  });

  it("Given 고른 컬렉션이 다른 곳에서 지워짐 When 다시 읽으면 Then 초안에서 그 컬렉션만 뺀다", () => {
    const start = ready({ dialog: opened({ draft: { collectionIds: [desk.id, room.id] } }), refreshing: true });
    const { state } = transition(start, { type: "library.settled", outcome: { ok: true, value: { ...library, collections: [room] } } });
    expect(detailOf(state).draft).toEqual({ collectionIds: [room.id] });
  });
});

describe("상세에서 구매 기록", () => {
  const bought = (purchase: Extract<ProductResponse["purchase"], { status: "purchased" }>) => ({ ...lamp, revision: 2, purchase });
  const recording = (product: ProductResponse, draft: Detail["draft"]) => withProducts([product, chair], { dialog: opened({ draft }) });

  it("Given 구매한 상품 When 빈 구매일과 0원을 저장하면 Then 미입력 날짜와 0원을 보낸다", () => {
    const { call } = transition(recording(bought({ status: "purchased", date: "2026-11-01", price: null }), { date: "", price: "0" }),
      { type: "detail.save", form: "record", today });
    expect(call).toEqual({
      type: "product.change", productId: lamp.id,
      body: { revision: 2, change: { type: "purchase.record", date: null, price: { amountMinor: 0, currency: "KRW" } } },
    });
  });

  it("Given 저장한 구매 기록 When 상세를 열면 Then 양식이 그 값을 보여주고 0원과 미입력을 구분한다", () => {
    expect(detailForms(bought({ status: "purchased", date: "2026-11-01", price: { amountMinor: 0, currency: "KRW" } }), {}))
      .toMatchObject({ date: "2026-11-01", price: "0", recordChanged: false });
    expect(detailForms(bought({ status: "purchased", date: null, price: null }), {})).toMatchObject({ date: "", price: "" });
  });

  it.each([
    ["서울 기준 내일", { date: "2026-11-14" }, "date", "구매일은 오늘까지 입력할 수 있어요."],
    ["쉼표가 들어간 금액", { price: "1,000" }, "price", "실구매가는 0 이상의 정수로 입력해 주세요."],
  ])("Given %s When 저장하면 Then 요청하지 않고 그 칸에 오류를 보여준다", (_, draft, field, message) => {
    const { state, call } = transition(recording(bought({ status: "purchased", date: null, price: null }), draft),
      { type: "detail.save", form: "record", today });
    expect(call).toBeNull();
    expect(detailOf(state).notice).toEqual({ form: "record", kind: "error", field, message });
  });

  it("Given 위시 상품 When 구매 기록을 저장하면 Then 요청하지 않는다", () => {
    const state = recording(lamp, { price: "1000" });
    expect(transition(state, { type: "detail.save", form: "record", today })).toEqual({ state, call: null });
  });

  it("Given 구매 기록 저장 중 When 성공하면 Then 구매 정보를 저장했다고 알리고 이름·메모 초안은 지킨다", () => {
    const recorded = bought({ status: "purchased", date: "2026-11-01", price: null });
    const start = withProducts([bought({ status: "purchased", date: null, price: null })], {
      dialog: opened({ draft: { note: "메모", date: "2026-11-01" } }), writing: { productId: lamp.id, intent: "purchase.record" },
    });
    const { state } = transition(start, { type: "change.settled", productId: lamp.id, intent: "purchase.record", outcome: { ok: true, value: { product: { ...recorded, revision: 3 } } } });
    expect(detailOf(state)).toEqual(opened({
      draft: { note: "메모" }, notice: { form: "record", kind: "saved", field: null, message: "구매 정보를 저장했어요" },
    }));
  });
});

describe("상세에서 구매완료와 위시로 되돌리기", () => {
  it("Given 위시 상품의 상세 When 구매완료로 옮기면 Then 성공하면 상세를 닫고 실행 취소 알림을 띄운다", () => {
    const start = ready({ dialog: opened() });
    const asked = transition(start, { type: "product.purchase", productId: lamp.id });
    expect(asked.call).toMatchObject({ body: { revision: 1, change: { type: "purchase" } } });
    expect(transition(asked.state, { type: "dialog.close" }).state).toBe(asked.state);
    const { state } = transition(asked.state, changed(purchasedLamp));
    expect(state).toMatchObject({ dialog: null, toast: { kind: "purchased", productId: lamp.id, revision: 2 } });
  });

  it("Given 구매한 상품의 상세 When 위시로 되돌리면 Then 성공하면 상세를 닫고 되돌렸다고 알린다", () => {
    const start = withProducts([purchasedLamp, chair], { dialog: opened() });
    const asked = transition(start, { type: "product.wish", productId: lamp.id });
    expect(asked.call).toMatchObject({ body: { revision: 2, change: { type: "wish" } } });
    const { state } = transition(asked.state, changed({ ...lamp, revision: 3 }, "wish"));
    expect(state).toMatchObject({ dialog: null, toast: { kind: "notice", message: "위시리스트로 되돌렸어요" } });
  });

  it("Given 상세에서 구매완료로 옮기는 중 When 다른 곳에서 먼저 바뀌어 거절되면 Then 상세에 알리고 다시 읽는다", () => {
    const start = ready({ dialog: opened(), writing: purchasing });
    const { state, call } = transition(start, failedChange(conflict));
    expect(call).toEqual({ type: "library.read" });
    expect(detailOf(state).notice).toEqual({ form: "status", kind: "error", field: null, message: conflict.message });
    expect(state).toMatchObject({ toast: null });
  });
});

describe("컬렉션 이름 바꾸기", () => {
  const renaming = (name: string, overrides: Partial<Extract<ScreenDialog, { kind: "collection" }>> = {}): ScreenDialog =>
    ({ kind: "collection", renaming: desk.id, name, saving: false, error: null, ...overrides });

  it("Given 고른 컬렉션 When 이름 바꾸기를 열면 Then 지금 이름을 채운 대화상자를 열고 알림을 닫는다", () => {
    const start = ready({ collectionId: desk.id, toast: { kind: "notice", message: "위시리스트로 되돌렸어요" } });
    expect(transition(start, { type: "rename.open", collectionId: desk.id }).state)
      .toEqual(ready({ collectionId: desk.id, dialog: renaming("Desk") }));
    const missing = ready();
    expect(transition(missing, { type: "rename.open", collectionId: "99999999-9999-4999-8999-999999999999" })).toEqual({ state: missing, call: null });
  });

  it("Given 새 이름 When 저장하면 Then 정리한 이름을 컬렉션의 revision으로 보내고 저장 중에는 다시 보내지 않는다", () => {
    const { state, call } = run(ready({ dialog: renaming("Desk") }), { type: "collection.edit", name: " 작업 공간 " }, { type: "collection.submit" });
    expect(call).toEqual({ type: "collection.rename", collectionId: desk.id, body: { revision: 1, name: "작업 공간" } });
    expect(dialogOf(state)).toEqual(renaming(" 작업 공간 ", { saving: true }));
    expect(transition(state, { type: "collection.submit" })).toEqual({ state, call: null });
    expect(transition(state, { type: "dialog.close" })).toEqual({ state, call: null });
  });

  it("Given 이름을 그대로 둠 When 저장하면 Then 요청하지 않고 닫는다", () => {
    expect(run(ready({ dialog: renaming("Desk") }), { type: "collection.submit" })).toEqual({ state: ready(), call: null });
  });

  it("Given 자기 이름의 대소문자만 바꿈 When 저장하면 Then 요청하고, 다른 컬렉션과 같은 이름이면 요청하지 않고 거절한다", () => {
    expect(run(ready({ dialog: renaming("desk") }), { type: "collection.submit" }).call)
      .toEqual({ type: "collection.rename", collectionId: desk.id, body: { revision: 1, name: "desk" } });
    const duplicate = run(ready({ dialog: renaming(" 방 ") }), { type: "collection.submit" });
    expect(duplicate.call).toBeNull();
    expect(dialogOf(duplicate.state)).toEqual(renaming(" 방 ", { error: { field: "collection", message: "같은 이름의 컬렉션이 이미 있어요." } }));
    const empty = run(ready({ dialog: renaming(" ") }), { type: "collection.submit" });
    expect(dialogOf(empty.state)).toMatchObject({ error: { field: "collection", message: "컬렉션 이름은 1~40자로 입력해 주세요." } });
  });

  it("Given 저장 중 When 바뀌면 Then 같은 자리의 컬렉션 이름만 바꾸고 소속 상품과 필터는 그대로 두며 알린다", () => {
    const renamed = { ...desk, name: "작업 공간", revision: 2 };
    const { state } = transition(ready({ collectionId: desk.id, dialog: renaming("작업 공간", { saving: true }) }),
      { type: "rename.settled", outcome: { ok: true, value: renamed } });
    expect(state).toEqual(ready({
      library: { ...library, collections: [renamed, room] },
      collectionId: desk.id,
      toast: { kind: "notice", message: "컬렉션 이름을 바꿨어요" },
    }));
    expect(visibleProducts((state as Ready).library, "wish", desk.id)).toEqual([lamp]);
  });

  it("Given 저장 중 When 다른 곳에서 먼저 바뀌었거나 같은 이름이 생겼다고 거절되면 Then 입력을 지키고 안내하며 보관함을 다시 읽는다", () => {
    const failure: ApiFailure = { kind: "stale", message: "다른 곳에서 먼저 바뀌었어요. 최신 내용을 불러왔어요. 확인 후 다시 저장해 주세요." };
    const { state, call } = transition(ready({ dialog: renaming("작업 공간", { saving: true }) }), { type: "rename.settled", outcome: { ok: false, failure } });
    expect(call).toEqual({ type: "library.read" });
    expect(state).toMatchObject({ refreshing: true });
    expect(dialogOf(state)).toEqual(renaming("작업 공간", { error: { field: "collection", message: failure.message } }));
  });
});

describe("기다리는 수집 깨우기", () => {
  const stalledLamp: ProductResponse = { ...lamp, metadata: { phase: "queued", generation: 1, attempts: 0, stalled: true } };
  const woken: ProductResponse = { ...lamp, metadata: { phase: "queued", generation: 1, attempts: 0, stalled: false } };

  it("Given 멈춘 것으로 보이던 상품 When 깨운 결과가 오면 Then 그 상품만 대기로 바꾸고 나머지는 그대로다", () => {
    const { state, call } = transition(withProducts([stalledLamp, chair]), { type: "wake.settled", outcome: { ok: true, value: { products: [woken] } } });
    expect(productsOf(state)).toEqual([woken, chair]);
    expect(call).toBeNull();
    expect(pollDelay(state, 0)).not.toBeNull();
  });

  it("Given 깨우는 사이 소유자가 고친 상품 When 오래된 깨우기 결과가 오면 Then 고친 값을 지킨다", () => {
    const edited = { ...stalledLamp, title: "책상 조명", revision: 2 };
    const { state } = transition(withProducts([edited, chair]), { type: "wake.settled", outcome: { ok: true, value: { products: [woken] } } });
    expect(productsOf(state)[0]).toMatchObject({ title: "책상 조명", revision: 2 });
  });

  it("Given 깨우기 실패 When 결과가 오면 Then 알리지 않고 화면을 그대로 둔다", () => {
    const before = withProducts([stalledLamp, chair]);
    expect(transition(before, { type: "wake.settled", outcome: { ok: false, failure: unavailable } })).toEqual({ state: before, call: null });
  });

  it("Given 로그인이 끝난 세션 When 깨우기 결과가 오면 Then 로그인으로 떠난다", () => {
    const { state } = transition(ready(), { type: "wake.settled", outcome: { ok: false, failure: { kind: "redirect", to: "/login" } } });
    expect(state).toEqual({ phase: "leaving", to: "/login" });
  });
});

describe("공유 저장 보기", () => {
  const shown = { status: "ready" as const, key: shareKey, secret: shareSecret, confirm: null, busy: false, notice: null };

  it("Given 위시 보기 When 공유 저장으로 가면 Then 키를 읽기 시작한다", () => {
    expect(transition(ready(), { type: "view", view: "share" }))
      .toEqual({ state: ready({ view: "share", share: { status: "loading" } }), call: { type: "key.read", endpoint: "share" } });
  });

  it("Given 비밀이 보이는 공유 저장 보기 When 다른 보기로 가면 Then 비밀을 지운다", () => {
    const { state, call } = transition(ready({ view: "share", share: shown }), { type: "view", view: "purchased" });
    expect(state).toEqual(ready({ view: "purchased", share: { ...shown, secret: null } }));
    expect(call).toBeNull();
  });

  it("Given 공유 저장 보기 When 컬렉션을 고르면 Then 그 컬렉션의 위시 보기로 간다", () => {
    expect(transition(ready({ view: "share" }), { type: "filter", collectionId: desk.id }).state)
      .toEqual(ready({ view: "wish", collectionId: desk.id }));
  });

  it("Given 공유 저장 보기에서 키를 만듦 When 응답 전에 떠났다가 비밀이 오면 Then 비밀을 보이지 않는다", () => {
    const busy = { ...shown, key: null, secret: null, busy: true };
    const left = transition(ready({ view: "share", share: busy }), { type: "view", view: "wish" }).state;
    const { state } = transition(left, { type: "key.issue.settled", endpoint: "share", outcome: { ok: true, value: { key: shareKey, secret: shareSecret } } });
    expect((state as Ready).share).toEqual({ ...shown, secret: null });
  });

  it("Given 공유 저장 보기 When 패널 사건이 오면 Then 패널의 요청을 그대로 보낸다", () => {
    const empty = { ...shown, key: null, secret: null };
    expect(transition(ready({ view: "share", share: empty }), { type: "key.create", endpoint: "share" }))
      .toEqual({ state: ready({ view: "share", share: { ...empty, busy: true } }), call: { type: "key.issue", endpoint: "share", replaces: null } });
  });

  it("Given 세션이 끝남 When 키 결과가 오면 Then 로그인으로 떠난다", () => {
    const outcome = { ok: false as const, failure: { kind: "redirect" as const, to: "/login" } };
    expect(transition(ready({ view: "share", share: { status: "loading" } }), { type: "key.read.settled", endpoint: "share", outcome }).state)
      .toEqual({ phase: "leaving", to: "/login" });
  });

  it("Given 뒤로 가기 캐시에서 돌아온 공유 저장 보기 When 다시 보이면 Then 비밀 없이 처음부터 다시 불러온다", () => {
    expect(transition(ready({ view: "share", share: shown }), { type: "resume" })).toEqual(initialScreen);
  });
});

describe("자동 확인", () => {
  const shown = { status: "ready" as const, key: workerKey, secret: workerSecret, confirm: null, busy: false, notice: null };
  const opened = (panel: KeyPanel = shown, runs: WorkerRunResponse[] = []) => ready({ dialog: { kind: "worker" }, worker: { panel, runs } });

  it("Given 보관함 When 자동 확인을 열면 Then 대화상자를 열고 작업 키와 실행 기록을 읽는다", () => {
    expect(transition(ready(), { type: "worker.open" }))
      .toEqual({ state: ready({ dialog: { kind: "worker" }, worker: { panel: { status: "loading" }, runs: [] } }), call: { type: "key.read", endpoint: "worker" } });
  });

  it("Given 읽는 중 When 키와 실행 기록이 오면 Then 패널에 키를, 기록에 최근 실행을 둔다", () => {
    const { state } = transition(opened({ status: "loading" }), {
      type: "key.read.settled", endpoint: "worker", outcome: { ok: true, value: { key: workerKey, runs: [workerRun] } },
    });
    expect((state as Ready).worker).toEqual({ panel: { ...shown, secret: null }, runs: [workerRun] });
    expect((state as Ready).share).toEqual({ status: "unread" });
  });

  it("Given 비밀이 보이는 자동 확인 When 닫으면 Then 비밀과 확인을 지우고 키와 기록은 남긴다", () => {
    const { state } = transition(opened(shown, [workerRun]), { type: "dialog.close" });
    expect(state).toEqual(ready({ worker: { panel: { ...shown, secret: null }, runs: [workerRun] } }));
  });

  it("Given 키를 만드는 중 닫음 When 비밀이 오면 Then 비밀을 보이지 않는다", () => {
    const busy = { ...shown, key: null, secret: null, busy: true };
    const closed = transition(opened(busy), { type: "dialog.close" }).state;
    const { state } = transition(closed, { type: "key.issue.settled", endpoint: "worker", outcome: { ok: true, value: { key: workerKey, secret: workerSecret } } });
    expect((state as Ready).worker.panel).toEqual({ ...shown, secret: null });
  });

  it("Given 실행 중인 기록이 보이는 자동 확인에서 바꾸기를 확인함 When 새 키가 오면 Then 비밀을 보이고 기록을 다시 읽어 멈춘 실행을 보인다", () => {
    const running: WorkerRunResponse = { ...workerRun, finishedAt: null, state: "running" };
    const issued = transition(opened({ ...shown, secret: null, busy: true }, [running]), {
      type: "key.issue.settled", endpoint: "worker", outcome: { ok: true, value: { key: workerKey, secret: workerSecret } },
    });
    expect(issued.call).toEqual({ type: "key.read", endpoint: "worker" });
    expect((issued.state as Ready).worker).toEqual({ panel: shown, runs: [running] });

    const stopped: WorkerRunResponse = { ...workerRun, state: "revoked" };
    const { state } = transition(issued.state, {
      type: "key.read.settled", endpoint: "worker", outcome: { ok: true, value: { key: workerKey, runs: [stopped] } },
    });
    expect((state as Ready).worker).toEqual({ panel: shown, runs: [stopped] });
  });

  it("Given 공유 저장 보기와 자동 확인 When 작업 키 사건이 오면 Then 공유 키 패널은 그대로다", () => {
    const share = { ...shown, key: shareKey, secret: null };
    const { state, call } = transition(ready({ view: "share", share, dialog: { kind: "worker" }, worker: { panel: { ...shown, secret: null }, runs: [] } }),
      { type: "key.ask", endpoint: "worker", confirm: "revoke" });
    expect((state as Ready).share).toEqual(share);
    expect((state as Ready).worker.panel).toMatchObject({ confirm: "revoke" });
    expect(call).toBeNull();
  });

  it("Given 실패한 읽기 When 다시 읽기가 실패하면 Then 이미 보인 기록을 지우지 않는다", () => {
    const quiet = { ...shown, secret: null };
    const { state } = transition(opened(quiet, [workerRun]), { type: "key.read.settled", endpoint: "worker", outcome: { ok: false, failure: unavailable } });
    expect((state as Ready).worker.runs).toEqual([workerRun]);
  });

  it("Given 세션이 끝남 When 작업 키 결과가 오면 Then 로그인으로 떠난다", () => {
    const outcome = { ok: false as const, failure: { kind: "redirect" as const, to: "/login" } };
    expect(transition(opened({ status: "loading" }), { type: "key.read.settled", endpoint: "worker", outcome }).state)
      .toEqual({ phase: "leaving", to: "/login" });
  });

  it("Given 백업을 복원하는 중 When 자동 확인을 열면 Then 열지 않는다", () => {
    const restoring = ready({ dialog: { kind: "backup", step: { name: "restoring", incoming: { products: 1, collections: 0 } }, notice: null } });
    expect(transition(restoring, { type: "worker.open" })).toEqual({ state: restoring, call: null });
  });
});
