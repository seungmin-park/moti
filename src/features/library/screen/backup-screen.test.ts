import { describe, expect, it, vi } from "vitest";
import { MAX_BACKUP_BYTES, toLibraryBackupDocument } from "../presentation/library-backup";
import type { CollectionResponse, LibraryReadResponse, ProductResponse } from "../presentation/library-dto";
import type { ApiFailure, BackupFile, LibraryApi } from "./library-api";
import { perform, transition, visibleToast, type LibraryScreenState, type ScreenDialog, type ScreenEvent } from "./screen-state";

const desk: CollectionResponse = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Desk",
  revision: 1,
  createdAt: "2026-11-10T00:00:00.000Z",
  updatedAt: "2026-11-10T00:00:00.000Z",
};

function product(id: string, path: string, overrides: Partial<ProductResponse> = {}): ProductResponse {
  return {
    id,
    sourceUrl: `https://example.com/${path}`,
    identityUrl: `https://example.com/${path}`,
    option: "",
    shop: "example.com",
    title: "새로 담은 상품",
    note: "",
    revision: 1,
    collectionIds: [],
    addedAt: "2026-11-10T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
    purchase: { status: "wish" },
    metadata: { phase: "ready", generation: 1, attempts: 1, completedAt: "2026-11-10T00:00:01.000Z", image: { outcome: "absent" } },
    lastSuccessfulPrice: null,
    picture: null,
    ...overrides,
  };
}

const lamp = product("22222222-2222-4222-8222-222222222222", "lamp", { collectionIds: [desk.id] });
const chair = product("44444444-4444-4444-8444-444444444444", "chair");
const library: LibraryReadResponse = { products: [lamp, chair], collections: [desk] };

type Ready = Extract<LibraryScreenState, { phase: "ready" }>;
type Backup = Extract<ScreenDialog, { kind: "backup" }>;

function ready(overrides: Partial<Ready> = {}): Ready {
  return {
    phase: "ready", library, view: "purchased", collectionId: desk.id, dialog: null, refreshing: false, writing: null, toast: null,
    share: { status: "unread" }, ...overrides,
  };
}

function run(state: LibraryScreenState, ...events: ScreenEvent[]) {
  let current = { state, call: null as ReturnType<typeof transition>["call"] };
  for (const event of events) current = transition(current.state, event);
  return current;
}

const backupOf = (state: LibraryScreenState) => (state as Ready).dialog as Backup;
const atStep = (step: Backup["step"], notice: Backup["notice"] = null) => ready({ dialog: { kind: "backup", step, notice } });
const menu = () => atStep({ name: "menu" });

// The file keeps the lamp (same link with a tracking value) and adds a sofa; the chair is not in it.
const fileText = JSON.stringify(toLibraryBackupDocument({
  collections: [{ name: "Desk", createdAt: "2026-11-10T00:00:00.000Z" }, { name: "거실", createdAt: "2026-11-11T00:00:00.000Z" }],
  products: [
    {
      sourceUrl: "https://example.com/lamp?utm_source=x", identityUrl: "https://example.com/lamp", option: "", shop: "example.com",
      collectedTitle: "조명", ownerTitle: null, note: "", collectionNames: ["Desk"], addedAt: "2026-11-10T00:00:00.000Z",
      purchase: { status: "wish" }, lastSuccessfulPrice: null,
    },
    {
      sourceUrl: "https://example.com/sofa", identityUrl: "https://example.com/sofa", option: "", shop: "example.com",
      collectedTitle: "소파", ownerTitle: null, note: "", collectionNames: [], addedAt: "2026-11-09T00:00:00.000Z",
      purchase: { status: "wish" }, lastSuccessfulPrice: null,
    },
  ],
}, new Date("2026-11-12T05:30:00.000Z")));

const exported: BackupFile = { name: "moti-backup-20261113-1412.json", text: fileText, counts: { products: 2, collections: 2 }, restorable: true };
const unavailable: ApiFailure = { kind: "unavailable", message: "연결을 확인하고 다시 시도해 주세요." };

describe("백업과 복원 대화상자", () => {
  it("Given 보관함 When 백업과 복원을 열면 Then 처음 단계의 대화상자가 열리고 알림을 닫는다", () => {
    const { state, call } = run(ready({ toast: { kind: "notice", message: "알림" } }), { type: "backup.open" });
    expect(backupOf(state)).toEqual({ kind: "backup", step: { name: "menu" }, notice: null });
    expect((state as Ready).toast).toBeNull();
    expect(call).toBeNull();
  });

  it("Given 처음 단계 When 백업 만들기를 누르면 Then 만드는 중이고 백업을 요청하며, 받으면 내려받기 단계가 된다", () => {
    const started = run(menu(), { type: "backup.export" });
    expect(backupOf(started.state).step).toEqual({ name: "exporting" });
    expect(started.call).toEqual({ type: "backup.export" });

    const done = run(started.state, { type: "backup.exported", outcome: { ok: true, value: exported } });
    expect(backupOf(done.state)).toEqual({ kind: "backup", step: { name: "exported", file: exported }, notice: null });
  });

  it("Given 백업을 만들지 못함 When 결과가 오면 Then 처음 단계에 오류를 보이고, 세션이 끝났으면 로그인으로 떠난다", () => {
    const failed = run(atStep({ name: "exporting" }), { type: "backup.exported", outcome: { ok: false, failure: unavailable } });
    expect(backupOf(failed.state)).toEqual({ kind: "backup", step: { name: "menu" }, notice: { kind: "error", message: unavailable.message } });

    const redirected = run(atStep({ name: "exporting" }), { type: "backup.exported", outcome: { ok: false, failure: { kind: "redirect", to: "/login" } } });
    expect(redirected.state).toEqual({ phase: "leaving", to: "/login" });
  });

  it("Given 만드는 중·읽는 중·바꾸는 중 When 닫거나 다른 단계를 누르면 Then 그대로다", () => {
    for (const step of [{ name: "exporting" }, { name: "reading", fileName: "a.json" }, { name: "restoring", incoming: { products: 1, collections: 0 } }] as const) {
      const busy = atStep(step);
      for (const event of [{ type: "dialog.close" }, { type: "backup.export" }, { type: "backup.back" }, { type: "add.open" }] as ScreenEvent[]) {
        expect(run(busy, event)).toEqual({ state: busy, call: null });
      }
    }
  });

  it("Given 처음 단계 When 4MB보다 큰 파일을 고르면 Then 읽지 않고 오류를 보인다", () => {
    const file = { name: "big.json", size: MAX_BACKUP_BYTES + 1 } as File;
    const { state, call } = run(menu(), { type: "backup.choose", file });
    expect(backupOf(state)).toEqual({ kind: "backup", step: { name: "menu" }, notice: { kind: "error", message: "4MB보다 큰 백업은 한 번에 복원할 수 없어요." } });
    expect(call).toBeNull();
  });

  it("Given 처음 단계 When 파일을 고르면 Then 읽는 중이고 그 파일을 읽는다", () => {
    const file = new File([fileText], "moti-backup.json", { type: "application/json" });
    const { state, call } = run(menu(), { type: "backup.choose", file });
    expect(backupOf(state).step).toEqual({ name: "reading", fileName: "moti-backup.json" });
    expect(call).toEqual({ type: "backup.file", file });
  });

  it("Given 읽은 백업 When 확인 단계가 되면 Then 지금과 파일의 개수, 파일에 없어 지워질 상품 수와 백업 시각을 보인다", () => {
    const { state } = run(atStep({ name: "reading", fileName: "moti-backup.json" }), { type: "backup.read", fileName: "moti-backup.json", text: fileText });
    expect(backupOf(state)).toEqual({
      kind: "backup",
      notice: null,
      step: {
        name: "confirm",
        fileName: "moti-backup.json",
        text: fileText,
        exportedAt: "2026-11-12T05:30:00.000Z",
        current: { products: 2, collections: 1 },
        incoming: { products: 2, collections: 2 },
        removed: 1,
      },
    });
  });

  it.each([
    ["JSON이 아닌 파일", "not json", "moti 백업 파일이 아니에요."],
    ["다른 JSON", JSON.stringify({ products: [] }), "moti 백업 파일이 아니에요."],
    ["더 새로운 버전", JSON.stringify({ format: "moti.library-backup", version: 2 }), "더 새로운 moti에서 만든 백업이에요. 화면을 새로고침한 뒤 다시 시도해 주세요."],
    ["바뀐 파일", JSON.stringify({ ...JSON.parse(fileText), signature: "x" }), "백업 파일이 손상되었거나 바뀌었어요. 보관함은 바뀌지 않았어요."],
  ])("Given %s When 읽으면 Then 요청 없이 처음 단계에 오류를 보인다", (_, text, message) => {
    const { state, call } = run(atStep({ name: "reading", fileName: "x.json" }), { type: "backup.read", fileName: "x.json", text });
    expect(backupOf(state)).toEqual({ kind: "backup", step: { name: "menu" }, notice: { kind: "error", message } });
    expect(call).toBeNull();
  });

  it("Given 읽지 못한 파일 When 결과가 오면 Then 처음 단계에 오류를 보인다", () => {
    const { state } = run(atStep({ name: "reading", fileName: "x.json" }), { type: "backup.unreadable" });
    expect(backupOf(state).notice).toEqual({ kind: "error", message: "파일을 읽지 못했어요." });
  });

  const confirming = (overrides: Partial<Ready> = {}) => ({
    ...run(atStep({ name: "reading", fileName: "moti-backup.json" }), { type: "backup.read", fileName: "moti-backup.json", text: fileText }).state as Ready,
    ...overrides,
  });

  it("Given 확인 단계 When 취소하면 Then 요청 없이 처음 단계로 돌아간다", () => {
    expect(run(confirming(), { type: "backup.back" })).toEqual({ state: menu(), call: null });
  });

  it("Given 확인 단계 When 보관함 바꾸기를 누르면 Then 바꾸는 중이고 고른 파일의 글자를 그대로 보낸다", () => {
    const { state, call } = run(confirming(), { type: "backup.restore" });
    expect(backupOf(state).step).toEqual({ name: "restoring", incoming: { products: 2, collections: 2 } });
    expect(call).toEqual({ type: "library.restore", text: fileText });
  });

  it("Given 다른 쓰기나 다시 읽기가 진행 중 When 보관함 바꾸기를 누르면 Then 기다린다", () => {
    for (const overrides of [{ refreshing: true }, { writing: { productId: lamp.id, intent: "purchase" as const } }]) {
      const waiting = confirming(overrides);
      expect(run(waiting, { type: "backup.restore" })).toEqual({ state: waiting, call: null });
    }
  });

  it("Given 바꾸는 중 When 구매·위시 되돌리기·다시 수집·실행 취소가 들어오면 Then 복원 전 revision으로 쓰기를 시작하지 않는다", () => {
    const bought = { ...chair, purchase: { status: "purchased" as const, date: null, price: null } };
    const failed = product("66666666-6666-4666-8666-666666666666", "desk", { metadata: { phase: "failed", generation: 1, attempts: 3, errorCode: "blocked_address" } });
    const restoring = ready({
      library: { products: [lamp, bought, failed], collections: [desk] },
      view: "wish",
      dialog: { kind: "backup", step: { name: "restoring", incoming: { products: 2, collections: 2 } }, notice: null },
      toast: { kind: "purchased", productId: lamp.id, revision: lamp.revision },
    });
    for (const event of [
      { type: "product.purchase", productId: lamp.id },
      { type: "product.wish", productId: bought.id },
      { type: "metadata.retry", productId: failed.id },
      { type: "toast.undo" },
    ] as const) {
      const { state, call } = run(restoring, event);
      expect(call, event.type).toBeNull();
      expect((state as Ready).writing, event.type).toBeNull();
    }
  });

  it("Given 바꾸는 중 When 복원이 끝나면 Then 보관함을 응답으로 바꾸고 위시 전체 보기로 돌아가 대화상자를 닫고 알린다", () => {
    const sofa = product("55555555-5555-4555-8555-555555555555", "sofa", { metadata: { phase: "queued", generation: 1, attempts: 0, stalled: false } });
    const restored: LibraryReadResponse = { products: [{ ...lamp, revision: 2, title: "조명" }, sofa], collections: [desk] };
    const restoring = run(confirming(), { type: "backup.restore" }).state;

    const { state, call } = run(restoring, { type: "restore.settled", outcome: { ok: true, value: restored } });

    expect(state).toEqual(ready({ library: restored, view: "wish", collectionId: null, dialog: null, toast: { kind: "notice", message: "보관함을 복원했어요. 새 상품의 사진은 차례로 다시 가져와요." } }));
    expect(call).toBeNull();
    expect(visibleToast(state as Ready)).toEqual({ message: "보관함을 복원했어요. 새 상품의 사진은 차례로 다시 가져와요.", undo: false });
  });

  it("Given 바꾸는 중 When 서버가 파일을 거절하면 Then 처음 단계에 바뀌지 않았다는 오류를 보이고 다시 읽지 않는다", () => {
    const restoring = run(confirming(), { type: "backup.restore" }).state;
    const refused: ApiFailure = { kind: "invalid", field: null, message: "백업 파일이 손상되었거나 바뀌었어요. 보관함은 바뀌지 않았어요." };
    const { state, call } = run(restoring, { type: "restore.settled", outcome: { ok: false, failure: refused } });
    expect(backupOf(state)).toEqual({ kind: "backup", step: { name: "menu" }, notice: { kind: "error", message: refused.message } });
    expect((state as Ready).library).toEqual(library);
    expect(call).toBeNull();
  });

  it("Given 바꾸는 중 When 연결이 끊기거나 저장소가 응답하지 않으면 Then 결과를 모른다고 알리고 보관함을 다시 읽는다", () => {
    const restoring = run(confirming(), { type: "backup.restore" }).state;
    const { state, call } = run(restoring, { type: "restore.settled", outcome: { ok: false, failure: unavailable } });
    expect(backupOf(state)).toEqual({
      kind: "backup",
      step: { name: "menu" },
      notice: { kind: "info", message: "복원을 마쳤는지 확인하지 못했어요. 최신 보관함을 다시 불러와요. 필요하면 같은 파일로 다시 복원해 주세요." },
    });
    expect((state as Ready).refreshing).toBe(true);
    expect(call).toEqual({ type: "library.read" });
  });

  it("Given 바꾸는 중 When 세션이 끝났으면 Then 로그인으로 떠난다", () => {
    const restoring = run(confirming(), { type: "backup.restore" }).state;
    expect(run(restoring, { type: "restore.settled", outcome: { ok: false, failure: { kind: "redirect", to: "/login" } } }).state)
      .toEqual({ phase: "leaving", to: "/login" });
  });

  it("Given 내려받기 단계 When 처음으로를 누르거나 닫으면 Then 처음 단계로 가거나 대화상자를 닫는다", () => {
    const done = atStep({ name: "exported", file: exported });
    expect(backupOf(run(done, { type: "backup.back" }).state)).toEqual({ kind: "backup", step: { name: "menu" }, notice: null });
    expect((run(done, { type: "dialog.close" }).state as Ready).dialog).toBeNull();
  });
});

describe("백업 요청 실행", () => {
  const api = {
    exportBackup: vi.fn(async () => ({ ok: true as const, value: exported })),
    restore: vi.fn(async () => ({ ok: true as const, value: library })),
  } as unknown as LibraryApi;

  it("Given 백업·복원 호출 When 실행하면 Then 결과 사건으로 돌려준다", async () => {
    await expect(perform(api, { type: "backup.export" })).resolves.toEqual({ type: "backup.exported", outcome: { ok: true, value: exported } });
    await expect(perform(api, { type: "library.restore", text: fileText })).resolves.toEqual({ type: "restore.settled", outcome: { ok: true, value: library } });
    expect(api.restore).toHaveBeenCalledWith(fileText);
  });

  it("Given 고른 파일 When 읽으면 Then 이름과 글자를 돌려주고, 읽지 못하면 읽지 못했다고 돌려준다", async () => {
    const file = new File([fileText], "moti-backup.json");
    await expect(perform(api, { type: "backup.file", file })).resolves.toEqual({ type: "backup.read", fileName: "moti-backup.json", text: fileText });
    const broken = { name: "broken.json", size: 1, text: () => Promise.reject(new Error("gone")) } as unknown as File;
    await expect(perform(api, { type: "backup.file", file: broken })).resolves.toEqual({ type: "backup.unreadable" });
  });
});
