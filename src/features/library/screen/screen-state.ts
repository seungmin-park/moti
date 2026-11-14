import { parseCollectionName } from "../../wishlist/collection-name";
import { parseLink } from "../../wishlist/link";
import { parsePaidPrice, parseProductNote, parseProductTitle, parsePurchaseDate } from "../../wishlist/product-fields";
import { MAX_BACKUP_BYTES, readLibraryBackup, type BackupCounts, type BackupProblem, type LibraryBackupDocument } from "../presentation/library-backup";
import type {
  CollectionCreateRequest,
  CollectionCreateResponse,
  CollectionRenameRequest,
  CollectionRenameResponse,
  CollectionResponse,
  LibraryReadResponse,
  LinkSaveRequest,
  LinkSaveResponse,
  MetadataRetryRequest,
  MetadataRetryResponse,
  MetadataWakeResponse,
  ProductChangeRequest,
  ProductChangeResponse,
  ProductResponse,
} from "../presentation/library-dto";
import type { WorkerRunResponse } from "../../worker/presentation/worker-dto";
import type { ApiFailure, ApiOutcome, BackupFile, FieldName, LibraryApi } from "./library-api";
import { canRetry } from "./product-view";
import { closeKeyPanel, isKeyEvent, onKeyPanel, openKeyPanel, type KeyCall, type KeyEvent, type KeyPanel } from "./key-panel-state";

export type View = "wish" | "purchased" | "share";
export type LinkDraft = { url: string; option: string; collectionIds: string[] };
export type FormError = { field: FieldName | null; message: string };
// Only the fields the owner touched. Every other field shows the live product, so collection results and a re-read
// reach the untouched fields with no extra step.
export type DetailDraft = { title?: string; note?: string; collectionIds?: string[]; date?: string; price?: string };
export type DetailForm = "retry" | "details" | "record" | "status";
export type DetailNotice = { form: DetailForm; kind: "error" | "saved"; field: FieldName | null; message: string };
export type BackupStep =
  | { name: "menu" }
  | { name: "exporting" }
  | { name: "exported"; file: BackupFile }
  | { name: "reading"; fileName: string }
  // `removed` counts the shown products whose link the file does not have: the restore deletes them.
  | { name: "confirm"; fileName: string; text: string; exportedAt: string; current: BackupCounts; incoming: BackupCounts; removed: number }
  | { name: "restoring"; incoming: BackupCounts };
export type BackupNotice = { kind: "error" | "info"; message: string };
export type ScreenDialog =
  | { kind: "add"; draft: LinkDraft; saving: boolean; creating: string | null; error: FormError | null }
  | { kind: "collection"; renaming: string | null; name: string; saving: boolean; error: FormError | null }
  | { kind: "detail"; productId: string; arrival: "added" | "duplicate" | null; draft: DetailDraft; notice: DetailNotice | null }
  | { kind: "backup"; step: BackupStep; notice: BackupNotice | null }
  | { kind: "worker" };
export type ProductChange = ProductChangeRequest["change"];
export type ProductIntent = "retry" | ProductChange["type"];
// The purchase toast offers undo only while the product still has the revision the purchase gave it.
export type Toast = { kind: "purchased"; productId: string; revision: number } | { kind: "notice"; message: string };
export type LibraryScreenState =
  | { phase: "loading" }
  | { phase: "failed"; message: string }
  | {
    phase: "ready";
    library: LibraryReadResponse;
    view: View;
    collectionId: string | null;
    dialog: ScreenDialog | null;
    refreshing: boolean;
    // One product write at a time; every button that would write waits for it.
    writing: { productId: string; intent: ProductIntent } | null;
    toast: Toast | null;
    share: KeyPanel;
    // The scheduled worker's key and its latest runs, shown in the 자동 확인 dialog.
    worker: { panel: KeyPanel; runs: WorkerRunResponse[] };
  }
  | { phase: "leaving"; to: string };
export type ApiCall =
  | { type: "library.read" }
  | { type: "link.save"; body: LinkSaveRequest }
  | { type: "collection.create"; body: CollectionCreateRequest; from: "picker" | "dialog" }
  | { type: "collection.rename"; collectionId: string; body: CollectionRenameRequest }
  | { type: "metadata.retry"; productId: string; body: MetadataRetryRequest }
  | { type: "product.change"; productId: string; body: ProductChangeRequest }
  | { type: "library.poll" }
  | { type: "backup.export" }
  | { type: "backup.file"; file: File }
  | { type: "library.restore"; text: string }
  | { type: "metadata.wake" }
  | KeyCall;
export type ScreenEvent =
  | { type: "retry" }
  | { type: "resume" }
  | { type: "view"; view: View }
  | { type: "filter"; collectionId: string | null }
  | { type: "add.open" }
  | { type: "add.edit"; url?: string; option?: string }
  | { type: "add.toggle"; collectionId: string }
  | { type: "add.createCollection"; name: string }
  | { type: "add.submit" }
  | { type: "collection.open" }
  | { type: "rename.open"; collectionId: string }
  | { type: "collection.edit"; name: string }
  | { type: "collection.submit" }
  | { type: "detail.open"; productId: string }
  | { type: "detail.edit"; field: "title" | "note" | "date" | "price"; value: string }
  | { type: "detail.toggle"; collectionId: string }
  | { type: "detail.save"; form: "details" | "record"; today: string }
  | { type: "product.purchase"; productId: string }
  | { type: "product.wish"; productId: string }
  | { type: "toast.undo" }
  | { type: "toast.dismiss" }
  | { type: "dialog.close" }
  | { type: "library.settled"; outcome: ApiOutcome<LibraryReadResponse> }
  | { type: "link.settled"; outcome: ApiOutcome<LinkSaveResponse> }
  | { type: "collection.settled"; from: "picker" | "dialog"; outcome: ApiOutcome<CollectionCreateResponse> }
  | { type: "rename.settled"; outcome: ApiOutcome<CollectionRenameResponse> }
  | { type: "metadata.retry"; productId: string }
  | { type: "metadata.settled"; productId: string; outcome: ApiOutcome<MetadataRetryResponse> }
  | { type: "change.settled"; productId: string; intent: ProductChange["type"]; outcome: ApiOutcome<ProductChangeResponse> }
  | { type: "poll" }
  | { type: "poll.settled"; outcome: ApiOutcome<LibraryReadResponse> }
  | { type: "backup.open" }
  | { type: "worker.open" }
  | { type: "backup.export" }
  | { type: "backup.exported"; outcome: ApiOutcome<BackupFile> }
  | { type: "backup.choose"; file: File }
  | { type: "backup.read"; fileName: string; text: string }
  | { type: "backup.unreadable" }
  | { type: "backup.back" }
  | { type: "backup.restore" }
  | { type: "restore.settled"; outcome: ApiOutcome<LibraryReadResponse> }
  | { type: "wake.settled"; outcome: ApiOutcome<MetadataWakeResponse> }
  | KeyEvent;
export type Transition = { state: LibraryScreenState; call: ApiCall | null };

export const initialScreen: Transition = { state: { phase: "loading" }, call: { type: "library.read" } };

type Ready = Extract<LibraryScreenState, { phase: "ready" }>;
type AddDialog = Extract<ScreenDialog, { kind: "add" }>;
type CollectionDialog = Extract<ScreenDialog, { kind: "collection" }>;
type DetailDialog = Extract<ScreenDialog, { kind: "detail" }>;
type BackupDialog = Extract<ScreenDialog, { kind: "backup" }>;

const stay = (state: LibraryScreenState): Transition => ({ state, call: null });
const leave = (to: string): Transition => stay({ phase: "leaving", to });
const refresh: ApiCall = { type: "library.read" };
// A write that settles before the pending read would be erased by the read's older snapshot.
const writes: ReadonlySet<ScreenEvent["type"]> = new Set(["add.submit", "add.createCollection", "collection.submit"]);

function busy(state: Ready): boolean {
  const { dialog, writing } = state;
  if (dialog === null) return false;
  if (dialog.kind === "detail") return writing !== null && writing.productId === dialog.productId && writing.intent !== "retry";
  if (dialog.kind === "backup") return ["exporting", "reading", "restoring"].includes(dialog.step.name);
  // The worker key panel may still be writing; closing forgets a secret that arrives later, as the share view does.
  if (dialog.kind === "worker") return false;
  return dialog.saving || (dialog.kind === "add" && dialog.creating !== null);
}

function sameName(collections: CollectionResponse[], name: string): CollectionResponse | undefined {
  const key = name.toLocaleLowerCase();
  return collections.find((collection) => collection.name.normalize("NFC").toLocaleLowerCase() === key);
}

function including(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id];
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function upsert(products: ProductResponse[], product: ProductResponse): ProductResponse[] {
  return [product, ...products.filter((item) => item.id !== product.id)];
}

const phaseOrder: Record<ProductResponse["metadata"]["phase"], number> = { queued: 0, running: 1, ready: 2, failed: 2 };

// A read can arrive after a newer save or retry; only collection progress moves forward on screen.
function isLater(incoming: ProductResponse["metadata"], shown: ProductResponse["metadata"]): boolean {
  if (incoming.generation !== shown.generation) return incoming.generation > shown.generation;
  return phaseOrder[incoming.phase] >= phaseOrder[shown.phase];
}

// The shown title moves with collection: it is the collected name unless the owner set one at the same revision. The
// price moves with the daily check too, which never touches anything the owner set.
function withProgress(shown: ProductResponse, incoming: ProductResponse): ProductResponse {
  if (!isLater(incoming.metadata, shown.metadata)) return shown;
  return {
    ...shown,
    title: incoming.title,
    metadata: incoming.metadata,
    lastSuccessfulPrice: incoming.lastSuccessfulPrice,
    priceCheck: incoming.priceCheck,
    picture: incoming.picture,
  };
}

// Write responses and full reads. A higher revision carries owner changes made since; a lower one was read before
// them and would bring old values back.
export function mergeProduct(shown: ProductResponse, incoming: ProductResponse): ProductResponse {
  if (incoming.revision !== shown.revision) return incoming.revision > shown.revision ? incoming : shown;
  return withProgress(shown, incoming);
}

// A poll moves only collection progress, so an open form's base never moves under it.
function withPolled(products: ProductResponse[], polled: ProductResponse[]): ProductResponse[] {
  const latest = new Map(polled.map((product) => [product.id, product]));
  return products.map((product) => {
    const next = latest.get(product.id);
    return next && next.revision >= product.revision ? withProgress(product, next) : product;
  });
}

function withResponse(products: ProductResponse[], product: ProductResponse): ProductResponse[] {
  return products.map((item) => (item.id === product.id ? mergeProduct(item, product) : item));
}

function withResponses(products: ProductResponse[], incoming: ProductResponse[]): ProductResponse[] {
  return incoming.reduce(withResponse, products);
}

// Products only the owner's session can finish: collections that never started (a share key's adds, or a restore or
// save whose run never began) and pictures the scheduled worker left waiting. The screen asks for them once it has
// the library.
function needsWake(library: LibraryReadResponse): boolean {
  return library.products.some(({ metadata }) =>
    (metadata.phase === "queued" && metadata.attempts === 0) || (metadata.phase === "ready" && metadata.image.outcome === "waiting"));
}

// A retry deliberately resets collection (a resumed job goes back to queued), so its answer replaces the product.
function replace(products: ProductResponse[], product: ProductResponse): ProductResponse[] {
  return products.map((item) => (item.id === product.id ? product : item));
}

function recordValues(product: ProductResponse): { date: string; price: string } {
  const { purchase } = product;
  if (purchase.status === "wish") return { date: "", price: "" };
  return { date: purchase.date ?? "", price: purchase.price ? String(purchase.price.amountMinor) : "" };
}

export type DetailForms = {
  title: string;
  note: string;
  collectionIds: string[];
  date: string;
  price: string;
  detailsChanged: boolean;
  recordChanged: boolean;
};

// What each form shows: a touched field's draft, otherwise the live product.
export function detailForms(product: ProductResponse, draft: DetailDraft): DetailForms {
  const live = recordValues(product);
  const forms = {
    title: draft.title ?? product.title,
    note: draft.note ?? product.note,
    collectionIds: draft.collectionIds ?? product.collectionIds,
    date: draft.date ?? live.date,
    price: draft.price ?? live.price,
  };
  return {
    ...forms,
    detailsChanged: forms.title !== product.title || forms.note !== product.note || !sameIds(forms.collectionIds, product.collectionIds),
    recordChanged: forms.date !== live.date || forms.price !== live.price,
  };
}

const formFields: Record<"details" | "record", readonly (keyof DetailDraft)[]> = {
  details: ["title", "note", "collectionIds"],
  record: ["date", "price"],
};

function withoutDrafts(draft: DetailDraft, form: "details" | "record"): DetailDraft {
  return Object.fromEntries(Object.entries(draft).filter(([field]) => !formFields[form].includes(field as keyof DetailDraft)));
}

function withDetailNotice(dialog: ScreenDialog | null, productId: string, notice: DetailNotice | null): ScreenDialog | null {
  return dialog?.kind === "detail" && dialog.productId === productId ? { ...dialog, notice } : dialog;
}

function detailOf(state: Ready, productId: string): DetailDialog | null {
  return state.dialog?.kind === "detail" && state.dialog.productId === productId ? state.dialog : null;
}

function findProduct(state: Ready, productId: string): ProductResponse | undefined {
  return state.library.products.find((item) => item.id === productId);
}

// A restore replaces every product, so no other write may start from a revision it is about to change.
function canWrite(state: Ready): boolean {
  const restoring = state.dialog?.kind === "backup" && state.dialog.step.name === "restoring";
  return state.writing === null && !state.refreshing && !restoring;
}

function write(state: Ready, product: ProductResponse, change: ProductChange): Transition {
  return {
    state: {
      ...state,
      writing: { productId: product.id, intent: change.type },
      toast: null,
      dialog: withDetailNotice(state.dialog, product.id, null),
    },
    call: { type: "product.change", productId: product.id, body: { revision: product.revision, change } },
  };
}

function onRetry(state: Ready, productId: string): Transition {
  const product = findProduct(state, productId);
  if (!canWrite(state) || !product || !canRetry(product)) return stay(state);
  return {
    state: { ...state, writing: { productId, intent: "retry" }, dialog: withDetailNotice(state.dialog, productId, null) },
    call: { type: "metadata.retry", productId, body: { generation: product.metadata.generation } },
  };
}

function onRetried(state: Ready, productId: string, outcome: ApiOutcome<MetadataRetryResponse>): Transition {
  const next: Ready = { ...state, writing: null };
  if (outcome.ok) {
    return stay({ ...next, library: { ...next.library, products: replace(next.library.products, outcome.value.product) } });
  }
  const { failure } = outcome;
  if (failure.kind === "redirect") return leave(failure.to);
  const dialog = withDetailNotice(next.dialog, productId, { form: "retry", kind: "error", field: null, message: failure.message });
  if (failure.kind === "stale") return { state: { ...next, dialog, refreshing: true }, call: refresh };
  return stay({ ...next, dialog });
}

function onDetailSave(state: Ready, dialog: DetailDialog, form: "details" | "record", today: string): Transition {
  const product = findProduct(state, dialog.productId);
  if (!product || !canWrite(state)) return stay(state);
  const reject = (field: FieldName, message: string) =>
    stay({ ...state, dialog: { ...dialog, notice: { form, kind: "error", field, message } } });
  const values = detailForms(product, dialog.draft);
  const settledDrafts = stay({ ...state, dialog: { ...dialog, draft: withoutDrafts(dialog.draft, form) } });
  if (form === "details") {
    const title = parseProductTitle(values.title);
    if (!title.ok) return reject("title", title.message);
    const note = parseProductNote(values.note);
    if (!note.ok) return reject("note", note.message);
    const titleChanged = title.value !== product.title;
    if (!titleChanged && note.value === product.note && sameIds(values.collectionIds, product.collectionIds)) return settledDrafts;
    return write(state, product, {
      type: "details", title: titleChanged ? title.value : null, note: note.value, collectionIds: values.collectionIds,
    });
  }
  if (product.purchase.status !== "purchased") return stay(state);
  const date = parsePurchaseDate(values.date, today);
  if (!date.ok) return reject("date", date.message);
  const price = parsePaidPrice(values.price);
  if (!price.ok) return reject("price", price.message);
  const stored = product.purchase.price;
  const samePrice = price.value === null ? stored === null
    : stored !== null && stored.amountMinor === price.value.amountMinor && stored.currency === price.value.currency;
  if (date.value === product.purchase.date && samePrice) return settledDrafts;
  return write(state, product, { type: "purchase.record", date: date.value, price: price.value });
}

function onDetail(state: Ready, dialog: DetailDialog, event: ScreenEvent): Transition {
  if (busy(state)) return stay(state);
  switch (event.type) {
    case "detail.edit":
      return stay({ ...state, dialog: { ...dialog, draft: { ...dialog.draft, [event.field]: event.value }, notice: null } });
    case "detail.toggle": {
      const product = findProduct(state, dialog.productId);
      if (!product) return stay(state);
      const ids = dialog.draft.collectionIds ?? product.collectionIds;
      const collectionIds = ids.includes(event.collectionId) ? ids.filter((id) => id !== event.collectionId) : [...ids, event.collectionId];
      return stay({ ...state, dialog: { ...dialog, draft: { ...dialog.draft, collectionIds }, notice: null } });
    }
    case "detail.save":
      return onDetailSave(state, dialog, event.form, event.today);
    default:
      return stay(state);
  }
}

function onPurchase(state: Ready, productId: string, to: "purchased" | "wish"): Transition {
  const product = findProduct(state, productId);
  if (!product || !canWrite(state) || product.purchase.status === to) return stay(state);
  return write(state, product, { type: to === "purchased" ? "purchase" : "wish" });
}

function onUndo(state: Ready): Transition {
  const { toast } = state;
  if (toast?.kind !== "purchased") return stay(state);
  const product = findProduct(state, toast.productId);
  if (!product || product.revision !== toast.revision) return stay(state);
  return onPurchase(state, product.id, "wish");
}

function onChanged(state: Ready, productId: string, intent: ProductChange["type"], outcome: ApiOutcome<ProductChangeResponse>): Transition {
  const next: Ready = { ...state, writing: null };
  const dialog = detailOf(next, productId);
  if (outcome.ok) {
    const products = withResponse(next.library.products, outcome.value.product);
    const library = { ...next.library, products };
    const shown = products.find((item) => item.id === productId) ?? outcome.value.product;
    switch (intent) {
      case "details":
      case "purchase.record": {
        const form = intent === "details" ? "details" : "record";
        const message = intent === "details" ? "변경사항을 저장했어요" : "구매 정보를 저장했어요";
        return stay({
          ...next,
          library,
          dialog: dialog ? { ...dialog, draft: withoutDrafts(dialog.draft, form), notice: { form, kind: "saved", field: null, message } } : next.dialog,
        });
      }
      case "purchase":
        return stay({ ...next, library, dialog: dialog ? null : next.dialog, toast: { kind: "purchased", productId, revision: shown.revision } });
      case "wish":
        return stay({ ...next, library, dialog: dialog ? null : next.dialog, toast: { kind: "notice", message: "위시리스트로 되돌렸어요" } });
    }
  }
  const { failure } = outcome;
  if (failure.kind === "redirect") return leave(failure.to);
  const form: DetailForm = intent === "details" ? "details" : intent === "purchase.record" ? "record" : "status";
  const field = failure.kind === "invalid" ? failure.field : null;
  const shownAt: Partial<Ready> = dialog
    ? { dialog: { ...dialog, notice: { form, kind: "error", field, message: failure.message } } }
    : { toast: { kind: "notice", message: failure.message } };
  if (failure.kind === "stale") return { state: { ...next, ...shownAt, refreshing: true }, call: refresh };
  return stay({ ...next, ...shownAt });
}

function withCollection(library: LibraryReadResponse, collection: CollectionResponse): LibraryReadResponse {
  if (library.collections.some((item) => item.id === collection.id)) {
    return { ...library, collections: library.collections.map((item) => (item.id === collection.id ? collection : item)) };
  }
  return { ...library, collections: [...library.collections, collection] };
}

function settledLibrary(state: Ready, library: LibraryReadResponse): Ready {
  const ids = new Set(library.collections.map((collection) => collection.id));
  const shown = new Map(state.library.products.map((product) => [product.id, product]));
  const products = library.products.map((product) => {
    const before = shown.get(product.id);
    return before ? mergeProduct(before, product) : product;
  });
  let dialog = state.dialog;
  if (dialog?.kind === "add") {
    dialog = { ...dialog, draft: { ...dialog.draft, collectionIds: dialog.draft.collectionIds.filter((id) => ids.has(id)) } };
  }
  if (dialog?.kind === "detail") {
    const { productId, draft } = dialog;
    if (!products.some((product) => product.id === productId)) dialog = null;
    else if (draft.collectionIds) dialog = { ...dialog, draft: { ...draft, collectionIds: draft.collectionIds.filter((id) => ids.has(id)) } };
  }
  return {
    ...state,
    library: { products, collections: library.collections },
    collectionId: state.collectionId !== null && ids.has(state.collectionId) ? state.collectionId : null,
    dialog,
    refreshing: false,
  };
}

function failForm(state: Ready, failure: ApiFailure, field: FieldName | null,
  dialog: (error: FormError) => ScreenDialog): Transition {
  switch (failure.kind) {
    case "redirect":
      return leave(failure.to);
    case "stale":
      return { state: { ...state, dialog: dialog({ field: "collection", message: failure.message }), refreshing: true }, call: refresh };
    case "invalid":
      return stay({ ...state, dialog: dialog({ field: failure.field, message: failure.message }) });
    case "unavailable":
      return stay({ ...state, dialog: dialog({ field, message: failure.message }) });
  }
}

function leaveOrStay(state: Ready, failure: ApiFailure): Transition {
  return failure.kind === "redirect" ? leave(failure.to) : stay(state);
}

function onAdd(state: Ready, dialog: AddDialog, event: ScreenEvent): Transition {
  const withDialog = (next: Partial<AddDialog>) => stay({ ...state, dialog: { ...dialog, ...next } });
  if (dialog.saving) return stay(state);
  switch (event.type) {
    case "add.edit":
      return withDialog({ draft: { ...dialog.draft, ...(event.url !== undefined && { url: event.url }),
        ...(event.option !== undefined && { option: event.option }) } });
    case "add.toggle": {
      const ids = dialog.draft.collectionIds;
      return withDialog({ draft: { ...dialog.draft, collectionIds: ids.includes(event.collectionId)
        ? ids.filter((id) => id !== event.collectionId)
        : [...ids, event.collectionId] } });
    }
    case "add.createCollection": {
      if (dialog.creating !== null) return stay(state);
      const result = parseCollectionName(event.name);
      if (!result.ok) return withDialog({ error: { field: "collection", message: result.message } });
      const existing = sameName(state.library.collections, result.name);
      if (existing) return withDialog({ draft: { ...dialog.draft, collectionIds: including(dialog.draft.collectionIds, existing.id) } });
      return {
        state: { ...state, dialog: { ...dialog, creating: result.name } },
        call: { type: "collection.create", body: { name: result.name }, from: "picker" },
      };
    }
    case "add.submit": {
      if (dialog.creating !== null) return stay(state);
      const parsed = parseLink(dialog.draft.url, dialog.draft.option);
      if (!parsed.ok) return withDialog({ error: { field: parsed.field, message: parsed.message } });
      return {
        state: { ...state, dialog: { ...dialog, saving: true, error: null } },
        call: { type: "link.save", body: { ...dialog.draft } },
      };
    }
    default:
      return stay(state);
  }
}

function onCollection(state: Ready, dialog: CollectionDialog, event: ScreenEvent): Transition {
  if (dialog.saving) return stay(state);
  if (event.type === "collection.edit") return stay({ ...state, dialog: { ...dialog, name: event.name } });
  if (event.type !== "collection.submit") return stay(state);
  const reject = (message: string) => stay({ ...state, dialog: { ...dialog, error: { field: "collection", message } } });
  const result = parseCollectionName(dialog.name);
  if (!result.ok) return reject(result.message);
  const { collections } = state.library;
  if (dialog.renaming === null) {
    if (sameName(collections, result.name)) return reject("같은 이름의 컬렉션이 이미 있어요.");
    return {
      state: { ...state, dialog: { ...dialog, saving: true, error: null } },
      call: { type: "collection.create", body: { name: result.name }, from: "dialog" },
    };
  }
  const target = collections.find((collection) => collection.id === dialog.renaming);
  if (!target) return reject("컬렉션을 찾을 수 없어요.");
  if (result.name === target.name) return stay({ ...state, dialog: null });
  if (sameName(collections.filter((collection) => collection.id !== target.id), result.name)) {
    return reject("같은 이름의 컬렉션이 이미 있어요.");
  }
  return {
    state: { ...state, dialog: { ...dialog, saving: true, error: null } },
    call: { type: "collection.rename", collectionId: target.id, body: { revision: target.revision, name: result.name } },
  };
}

const backupProblems: Record<BackupProblem, string> = {
  not_backup: "moti 백업 파일이 아니에요.",
  newer_version: "더 새로운 moti에서 만든 백업이에요. 화면을 새로고침한 뒤 다시 시도해 주세요.",
  invalid: "백업 파일이 손상되었거나 바뀌었어요. 보관함은 바뀌지 않았어요.",
};
const restoredNotice = "보관함을 복원했어요. 새 상품의 사진은 차례로 다시 가져와요.";
const restoreUnknown = "복원을 마쳤는지 확인하지 못했어요. 최신 보관함을 다시 불러와요. 필요하면 같은 파일로 다시 복원해 주세요.";

const linkKey = (identityUrl: string, option: string) => JSON.stringify([identityUrl, option]);

// Shown products the restore deletes: their link identity is not in the file.
function removedBy(library: LibraryReadResponse, document: LibraryBackupDocument): number {
  const kept = new Set(document.products.flatMap(({ sourceUrl, option }) => {
    const parsed = parseLink(sourceUrl, option);
    return parsed.ok ? [linkKey(parsed.link.identityUrl, parsed.link.option)] : [];
  }));
  return library.products.filter(({ identityUrl, option }) => !kept.has(linkKey(identityUrl, option))).length;
}

function readChosen(text: string): ReturnType<typeof readLibraryBackup> {
  try {
    return readLibraryBackup(JSON.parse(text));
  } catch {
    return { ok: false, problem: "not_backup", path: null };
  }
}

function onBackup(state: Ready, dialog: BackupDialog, event: ScreenEvent): Transition {
  const at = (step: BackupStep, notice: BackupNotice | null = null): Ready => ({ ...state, dialog: { kind: "backup", step, notice } });
  const menuWith = (kind: BackupNotice["kind"], message: string) => at({ name: "menu" }, { kind, message });
  const { step } = dialog;
  switch (event.type) {
    case "backup.export":
      if (busy(state)) return stay(state);
      return { state: at({ name: "exporting" }), call: { type: "backup.export" } };
    case "backup.exported":
      if (step.name !== "exporting") return stay(state);
      if (event.outcome.ok) return stay(at({ name: "exported", file: event.outcome.value }));
      if (event.outcome.failure.kind === "redirect") return leave(event.outcome.failure.to);
      return stay(menuWith("error", event.outcome.failure.message));
    case "backup.choose":
      if (busy(state)) return stay(state);
      if (event.file.size > MAX_BACKUP_BYTES) return stay(menuWith("error", "4MB보다 큰 백업은 한 번에 복원할 수 없어요."));
      return { state: at({ name: "reading", fileName: event.file.name }), call: { type: "backup.file", file: event.file } };
    case "backup.read": {
      if (step.name !== "reading") return stay(state);
      const reading = readChosen(event.text);
      if (!reading.ok) return stay(menuWith("error", backupProblems[reading.problem]));
      const { library } = state;
      return stay(at({
        name: "confirm",
        fileName: event.fileName,
        text: event.text,
        exportedAt: reading.document.exportedAt,
        current: { products: library.products.length, collections: library.collections.length },
        incoming: reading.counts,
        removed: removedBy(library, reading.document),
      }));
    }
    case "backup.unreadable":
      return step.name === "reading" ? stay(menuWith("error", "파일을 읽지 못했어요.")) : stay(state);
    case "backup.back":
      return busy(state) ? stay(state) : stay(at({ name: "menu" }));
    case "backup.restore":
      if (step.name !== "confirm" || !canWrite(state)) return stay(state);
      return { state: at({ name: "restoring", incoming: step.incoming }), call: { type: "library.restore", text: step.text } };
    default:
      return stay(state);
  }
}

// The response is the whole restored library: it replaces the shown one instead of merging, since restored products
// carry new ids or higher revisions and deleted ones are gone.
function onRestored(state: Ready, outcome: ApiOutcome<LibraryReadResponse>): Transition {
  if (outcome.ok) {
    return stay({
      ...state, library: outcome.value, view: "wish", collectionId: null, dialog: null, toast: { kind: "notice", message: restoredNotice },
    });
  }
  const { failure } = outcome;
  if (failure.kind === "redirect") return leave(failure.to);
  const at = (notice: BackupNotice): Ready => ({ ...state, dialog: { kind: "backup", step: { name: "menu" }, notice } });
  if (failure.kind === "invalid") return stay(at({ kind: "error", message: failure.message }));
  return { state: { ...at({ kind: "info", message: restoreUnknown }), refreshing: true }, call: refresh };
}

// A list view. Leaving the share view forgets the secret: the view decides whether it may stay visible.
function listing(state: Ready, view: Exclude<View, "share">): Ready {
  return { ...state, view, toast: null, share: closeKeyPanel(state.share) };
}

function onView(state: Ready, view: View): Transition {
  if (view === state.view) return stay(state);
  if (view !== "share") return stay(listing(state, view));
  const { panel, call } = openKeyPanel(state.share, "share");
  return { state: { ...state, view, toast: null, share: panel }, call };
}

// Each key's panel sees only its own events, and it is visible only where the owner can see it: the share key in the
// share view, the worker key in the 자동 확인 dialog.
function onKey(state: Ready, event: KeyEvent): Transition {
  if (event.endpoint === "share") {
    const { panel, call, leave: to } = onKeyPanel(state.share, event, state.view === "share");
    return to === null ? { state: { ...state, share: panel }, call } : leave(to);
  }
  const { panel, call, leave: to } = onKeyPanel(state.worker.panel, event, state.dialog?.kind === "worker");
  if (to !== null) return leave(to);
  // A read also brings the latest runs; a failed read keeps the ones already shown.
  const runs = event.type === "key.read.settled" && event.outcome.ok ? event.outcome.value.runs : state.worker.runs;
  return { state: { ...state, worker: { panel, runs } }, call };
}

function onReady(state: Ready, event: ScreenEvent): Transition {
  const { dialog } = state;
  if (isKeyEvent(event)) return onKey(state, event);
  switch (event.type) {
    case "view":
      return onView(state, event.view);
    case "filter": {
      // Collections hold products, so choosing one from the share view shows the wish list.
      const listed = state.view === "share" ? listing(state, "wish") : state;
      return stay({ ...listed, collectionId: event.collectionId, toast: null });
    }
    case "add.open":
      if (busy(state)) return stay(state);
      return stay({ ...state, toast: null, dialog: {
        kind: "add",
        draft: { url: "", option: "", collectionIds: state.collectionId ? [state.collectionId] : [] },
        saving: false,
        creating: null,
        error: null,
      } });
    case "collection.open":
      if (busy(state)) return stay(state);
      return stay({ ...state, toast: null, dialog: { kind: "collection", renaming: null, name: "", saving: false, error: null } });
    case "rename.open": {
      const target = state.library.collections.find((collection) => collection.id === event.collectionId);
      if (busy(state) || !target) return stay(state);
      return stay({ ...state, toast: null, dialog: { kind: "collection", renaming: target.id, name: target.name, saving: false, error: null } });
    }
    case "detail.open":
      if (busy(state)) return stay(state);
      return stay({ ...state, toast: null, dialog: { kind: "detail", productId: event.productId, arrival: null, draft: {}, notice: null } });
    case "backup.open":
      if (busy(state)) return stay(state);
      return stay({ ...state, toast: null, dialog: { kind: "backup", step: { name: "menu" }, notice: null } });
    case "worker.open": {
      if (busy(state)) return stay(state);
      // Opening reads the key and runs again, so the record is current.
      const { panel, call } = openKeyPanel(state.worker.panel, "worker");
      return { state: { ...state, toast: null, dialog: { kind: "worker" }, worker: { ...state.worker, panel } }, call };
    }
    case "restore.settled":
      return dialog?.kind === "backup" && dialog.step.name === "restoring" ? onRestored(state, event.outcome) : stay(state);
    case "wake.settled":
      if (event.outcome.ok) {
        return stay({ ...state, library: { ...state.library, products: withResponses(state.library.products, event.outcome.value.products) } });
      }
      return leaveOrStay(state, event.outcome.failure);
    case "dialog.close":
      if (busy(state)) return stay(state);
      // Closing the 자동 확인 dialog forgets the worker key's secret, as leaving the share view forgets the share key's.
      if (dialog?.kind === "worker") return stay({ ...state, dialog: null, worker: { ...state.worker, panel: closeKeyPanel(state.worker.panel) } });
      return stay({ ...state, dialog: null });
    case "library.settled":
      if (event.outcome.ok) return stay(settledLibrary(state, event.outcome.value));
      return leaveOrStay({ ...state, refreshing: false }, event.outcome.failure);
    case "link.settled": {
      if (event.outcome.ok) {
        const { kind, product } = event.outcome.value;
        return stay({
          ...state,
          library: { ...state.library, products: upsert(state.library.products, product) },
          dialog: dialog?.kind === "add" ? { kind: "detail", productId: product.id, arrival: kind, draft: {}, notice: null } : dialog,
        });
      }
      if (dialog?.kind !== "add") return leaveOrStay(state, event.outcome.failure);
      return failForm(state, event.outcome.failure, null, (error) => ({ ...dialog, saving: false, error }));
    }
    case "metadata.retry":
      return onRetry(state, event.productId);
    case "metadata.settled":
      return onRetried(state, event.productId, event.outcome);
    case "product.purchase":
      return onPurchase(state, event.productId, "purchased");
    case "product.wish":
      return onPurchase(state, event.productId, "wish");
    case "toast.undo":
      return onUndo(state);
    case "toast.dismiss":
      return stay({ ...state, toast: null });
    case "change.settled":
      return onChanged(state, event.productId, event.intent, event.outcome);
    case "poll":
      return { state, call: { type: "library.poll" } };
    case "poll.settled":
      if (event.outcome.ok) {
        return stay({ ...state, library: { ...state.library, products: withPolled(state.library.products, event.outcome.value.products) } });
      }
      return leaveOrStay(state, event.outcome.failure);
    case "collection.settled": {
      if (event.outcome.ok) {
        const collection = event.outcome.value;
        const library = withCollection(state.library, collection);
        if (event.from === "dialog" && dialog?.kind === "collection") {
          return stay({ ...state, library, collectionId: collection.id, dialog: null });
        }
        if (event.from === "picker" && dialog?.kind === "add") {
          return stay({ ...state, library, dialog: {
            ...dialog,
            creating: null,
            error: null,
            draft: { ...dialog.draft, collectionIds: including(dialog.draft.collectionIds, collection.id) },
          } });
        }
        return stay({ ...state, library });
      }
      if (event.from === "picker" && dialog?.kind === "add") {
        return failForm(state, event.outcome.failure, "collection", (error) => ({ ...dialog, creating: null, error }));
      }
      if (event.from === "dialog" && dialog?.kind === "collection") {
        return failForm(state, event.outcome.failure, null, (error) => ({ ...dialog, saving: false, error }));
      }
      return leaveOrStay(state, event.outcome.failure);
    }
    case "rename.settled": {
      const renaming = dialog?.kind === "collection" && dialog.renaming !== null ? dialog : null;
      if (event.outcome.ok) {
        return stay({
          ...state,
          library: withCollection(state.library, event.outcome.value),
          dialog: renaming ? null : dialog,
          toast: { kind: "notice", message: "컬렉션 이름을 바꿨어요" },
        });
      }
      if (!renaming) return leaveOrStay(state, event.outcome.failure);
      return failForm(state, event.outcome.failure, null, (error) => ({ ...renaming, saving: false, error }));
    }
    default:
      if (state.refreshing && writes.has(event.type)) return stay(state);
      if (dialog?.kind === "add") return onAdd(state, dialog, event);
      if (dialog?.kind === "collection") return onCollection(state, dialog, event);
      if (dialog?.kind === "detail") return onDetail(state, dialog, event);
      if (dialog?.kind === "backup") return onBackup(state, dialog, event);
      return stay(state);
  }
}

export function transition(state: LibraryScreenState, event: ScreenEvent): Transition {
  switch (state.phase) {
    case "leaving":
      return stay(state);
    case "loading": {
      if (event.type !== "library.settled") return stay(state);
      if (event.outcome.ok) {
        return {
          state: {
            phase: "ready", library: event.outcome.value, view: "wish", collectionId: null,
            dialog: null, refreshing: false, writing: null, toast: null, share: { status: "unread" },
            worker: { panel: { status: "unread" }, runs: [] },
          },
          call: needsWake(event.outcome.value) ? { type: "metadata.wake" } : null,
        };
      }
      const { failure } = event.outcome;
      return failure.kind === "redirect" ? leave(failure.to) : stay({ phase: "failed", message: failure.message });
    }
    case "failed":
      return event.type === "retry" || event.type === "resume" ? initialScreen : stay(state);
    case "ready":
      return event.type === "resume" ? initialScreen : onReady(state, event);
  }
}

export async function perform(api: LibraryApi, call: ApiCall): Promise<ScreenEvent> {
  switch (call.type) {
    case "library.read":
      return { type: "library.settled", outcome: await api.read() };
    case "link.save":
      return { type: "link.settled", outcome: await api.saveLink(call.body) };
    case "collection.create":
      return { type: "collection.settled", from: call.from, outcome: await api.createCollection(call.body) };
    case "collection.rename":
      return { type: "rename.settled", outcome: await api.renameCollection(call.collectionId, call.body) };
    case "metadata.retry":
      return { type: "metadata.settled", productId: call.productId, outcome: await api.retryMetadata(call.productId, call.body) };
    case "product.change":
      return {
        type: "change.settled",
        productId: call.productId,
        intent: call.body.change.type,
        outcome: await api.changeProduct(call.productId, call.body),
      };
    case "library.poll":
      return { type: "poll.settled", outcome: await api.read() };
    case "backup.export":
      return { type: "backup.exported", outcome: await api.exportBackup() };
    case "backup.file":
      try {
        return { type: "backup.read", fileName: call.file.name, text: await call.file.text() };
      } catch {
        return { type: "backup.unreadable" };
      }
    case "library.restore":
      return { type: "restore.settled", outcome: await api.restore(call.text) };
    case "metadata.wake":
      return { type: "wake.settled", outcome: await api.wake() };
    case "key.read":
      return call.endpoint === "share"
        ? { type: "key.read.settled", endpoint: "share", outcome: await api.readShareKey() }
        : { type: "key.read.settled", endpoint: "worker", outcome: await api.readWorker() };
    case "key.issue":
      return call.endpoint === "share"
        ? { type: "key.issue.settled", endpoint: "share", outcome: await api.issueShareKey({ replaces: call.replaces }) }
        : { type: "key.issue.settled", endpoint: "worker", outcome: await api.issueWorkerKey({ replaces: call.replaces }) };
    case "key.revoke":
      return call.endpoint === "share"
        ? { type: "key.revoke.settled", endpoint: "share", outcome: await api.revokeShareKey(call.keyId) }
        : { type: "key.revoke.settled", endpoint: "worker", outcome: await api.revokeWorkerKey(call.keyId) };
  }
}

export const MAX_POLLS = 40;
const pollDelays = [1500, 2000, 3000, 5000, 8000];

export function pollDelay(state: LibraryScreenState, polls: number): number | null {
  if (state.phase !== "ready" || polls >= MAX_POLLS) return null;
  const waiting = state.library.products.some(({ metadata }) =>
    (metadata.phase === "queued" || metadata.phase === "running") && !metadata.stalled);
  return waiting ? pollDelays[Math.min(polls, pollDelays.length - 1)] : null;
}

export function visibleProducts(library: LibraryReadResponse, view: View, collectionId: string | null): ProductResponse[] {
  return library.products
    .filter((product) => product.purchase.status === view && (collectionId === null || product.collectionIds.includes(collectionId)))
    .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export type ToastView = { message: string; undo: boolean };

// Hidden while a dialog is open, as in the mockup. The purchase toast disappears once the product changes again.
export function visibleToast(state: Ready): ToastView | null {
  const { toast } = state;
  if (toast === null || state.dialog !== null) return null;
  if (toast.kind === "notice") return { message: toast.message, undo: false };
  const product = findProduct(state, toast.productId);
  if (!product || product.revision !== toast.revision) return null;
  return { message: "구매완료 목록으로 옮겼어요", undo: true };
}

