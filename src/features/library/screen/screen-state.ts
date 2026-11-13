import { parseCollectionName } from "../../wishlist/collection-name";
import { parseLink } from "../../wishlist/link";
import { parsePaidPrice, parseProductNote, parseProductTitle, parsePurchaseDate } from "../../wishlist/product-fields";
import type {
  CollectionCreateRequest,
  CollectionCreateResponse,
  CollectionResponse,
  LibraryReadResponse,
  LinkSaveRequest,
  LinkSaveResponse,
  MetadataRetryRequest,
  MetadataRetryResponse,
  ProductChangeRequest,
  ProductChangeResponse,
  ProductResponse,
} from "../presentation/library-dto";
import type { ApiFailure, ApiOutcome, FieldName, LibraryApi } from "./library-api";
import { canRetry } from "./product-view";

export type View = "wish" | "purchased";
export type LinkDraft = { url: string; option: string; collectionIds: string[] };
export type FormError = { field: FieldName | null; message: string };
// Only the fields the owner touched. Every other field shows the live product, so collection results and a re-read
// reach the untouched fields with no extra step.
export type DetailDraft = { title?: string; note?: string; collectionIds?: string[]; date?: string; price?: string };
export type DetailForm = "retry" | "details" | "record" | "status";
export type DetailNotice = { form: DetailForm; kind: "error" | "saved"; field: FieldName | null; message: string };
export type ScreenDialog =
  | { kind: "add"; draft: LinkDraft; saving: boolean; creating: string | null; error: FormError | null }
  | { kind: "collection"; name: string; saving: boolean; error: FormError | null }
  | { kind: "detail"; productId: string; arrival: "added" | "duplicate" | null; draft: DetailDraft; notice: DetailNotice | null };
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
  }
  | { phase: "leaving"; to: string };
export type ApiCall =
  | { type: "library.read" }
  | { type: "link.save"; body: LinkSaveRequest }
  | { type: "collection.create"; body: CollectionCreateRequest; from: "picker" | "dialog" }
  | { type: "metadata.retry"; productId: string; body: MetadataRetryRequest }
  | { type: "product.change"; productId: string; body: ProductChangeRequest }
  | { type: "library.poll" };
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
  | { type: "metadata.retry"; productId: string }
  | { type: "metadata.settled"; productId: string; outcome: ApiOutcome<MetadataRetryResponse> }
  | { type: "change.settled"; productId: string; intent: ProductChange["type"]; outcome: ApiOutcome<ProductChangeResponse> }
  | { type: "poll" }
  | { type: "poll.settled"; outcome: ApiOutcome<LibraryReadResponse> };
export type Transition = { state: LibraryScreenState; call: ApiCall | null };

export const initialScreen: Transition = { state: { phase: "loading" }, call: { type: "library.read" } };

type Ready = Extract<LibraryScreenState, { phase: "ready" }>;
type AddDialog = Extract<ScreenDialog, { kind: "add" }>;
type CollectionDialog = Extract<ScreenDialog, { kind: "collection" }>;
type DetailDialog = Extract<ScreenDialog, { kind: "detail" }>;

const stay = (state: LibraryScreenState): Transition => ({ state, call: null });
const leave = (to: string): Transition => stay({ phase: "leaving", to });
const refresh: ApiCall = { type: "library.read" };
// A write that settles before the pending read would be erased by the read's older snapshot.
const writes: ReadonlySet<ScreenEvent["type"]> = new Set(["add.submit", "add.createCollection", "collection.submit"]);

function busy(state: Ready): boolean {
  const { dialog, writing } = state;
  if (dialog === null) return false;
  if (dialog.kind === "detail") return writing !== null && writing.productId === dialog.productId && writing.intent !== "retry";
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

// The shown title moves with collection: it is the collected name unless the owner set one at the same revision.
function withProgress(shown: ProductResponse, incoming: ProductResponse): ProductResponse {
  if (!isLater(incoming.metadata, shown.metadata)) return shown;
  return { ...shown, title: incoming.title, metadata: incoming.metadata, lastSuccessfulPrice: incoming.lastSuccessfulPrice, picture: incoming.picture };
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

function canWrite(state: Ready): boolean {
  return state.writing === null && !state.refreshing;
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
  if (library.collections.some((item) => item.id === collection.id)) return library;
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
  if (sameName(state.library.collections, result.name)) return reject("같은 이름의 컬렉션이 이미 있어요.");
  return {
    state: { ...state, dialog: { ...dialog, saving: true, error: null } },
    call: { type: "collection.create", body: { name: result.name }, from: "dialog" },
  };
}

function onReady(state: Ready, event: ScreenEvent): Transition {
  const { dialog } = state;
  switch (event.type) {
    case "view":
      return stay({ ...state, view: event.view, toast: null });
    case "filter":
      return stay({ ...state, collectionId: event.collectionId, toast: null });
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
      return stay({ ...state, toast: null, dialog: { kind: "collection", name: "", saving: false, error: null } });
    case "detail.open":
      if (busy(state)) return stay(state);
      return stay({ ...state, toast: null, dialog: { kind: "detail", productId: event.productId, arrival: null, draft: {}, notice: null } });
    case "dialog.close":
      return busy(state) ? stay(state) : stay({ ...state, dialog: null });
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
    default:
      if (state.refreshing && writes.has(event.type)) return stay(state);
      if (dialog?.kind === "add") return onAdd(state, dialog, event);
      if (dialog?.kind === "collection") return onCollection(state, dialog, event);
      if (dialog?.kind === "detail") return onDetail(state, dialog, event);
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
        return stay({
          phase: "ready", library: event.outcome.value, view: "wish", collectionId: null,
          dialog: null, refreshing: false, writing: null, toast: null,
        });
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

