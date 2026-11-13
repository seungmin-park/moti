import { parseCollectionName } from "../../wishlist/collection-name";
import { parseLink } from "../../wishlist/link";
import type {
  CollectionCreateRequest,
  CollectionCreateResponse,
  LibraryReadResponse,
  LinkSaveRequest,
  LinkSaveResponse,
  MetadataRetryRequest,
  MetadataRetryResponse,
  ProductResponse,
} from "../presentation/library-dto";
import type { ApiFailure, ApiOutcome, FieldName, LibraryApi } from "./library-api";
import { canRetry } from "./product-view";

export type LinkDraft = { url: string; option: string; collectionIds: string[] };
export type FormError = { field: FieldName | null; message: string };
export type ScreenDialog =
  | { kind: "add"; draft: LinkDraft; saving: boolean; creating: string | null; error: FormError | null }
  | { kind: "collection"; name: string; saving: boolean; error: FormError | null }
  | { kind: "detail"; productId: string; arrival: "added" | "duplicate" | null; error: string | null };
export type LibraryScreenState =
  | { phase: "loading" }
  | { phase: "failed"; message: string }
  | {
    phase: "ready";
    library: LibraryReadResponse;
    collectionId: string | null;
    dialog: ScreenDialog | null;
    refreshing: boolean;
    retrying: string | null;
  }
  | { phase: "leaving"; to: string };
export type ApiCall =
  | { type: "library.read" }
  | { type: "link.save"; body: LinkSaveRequest }
  | { type: "collection.create"; body: CollectionCreateRequest; from: "picker" | "dialog" }
  | { type: "metadata.retry"; productId: string; body: MetadataRetryRequest }
  | { type: "library.poll" };
export type ScreenEvent =
  | { type: "retry" }
  | { type: "resume" }
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
  | { type: "dialog.close" }
  | { type: "library.settled"; outcome: ApiOutcome<LibraryReadResponse> }
  | { type: "link.settled"; outcome: ApiOutcome<LinkSaveResponse> }
  | { type: "collection.settled"; from: "picker" | "dialog"; outcome: ApiOutcome<CollectionCreateResponse> }
  | { type: "metadata.retry"; productId: string }
  | { type: "metadata.settled"; productId: string; outcome: ApiOutcome<MetadataRetryResponse> }
  | { type: "poll" }
  | { type: "poll.settled"; outcome: ApiOutcome<LibraryReadResponse> };
export type Transition = { state: LibraryScreenState; call: ApiCall | null };

export const initialScreen: Transition = { state: { phase: "loading" }, call: { type: "library.read" } };

type Ready = Extract<LibraryScreenState, { phase: "ready" }>;
type AddDialog = Extract<ScreenDialog, { kind: "add" }>;
type CollectionDialog = Extract<ScreenDialog, { kind: "collection" }>;

const stay = (state: LibraryScreenState): Transition => ({ state, call: null });
const leave = (to: string): Transition => stay({ phase: "leaving", to });
const refresh: ApiCall = { type: "library.read" };
// A write that settles before the pending read would be erased by the read's older snapshot.
const writes: ReadonlySet<ScreenEvent["type"]> = new Set(["add.submit", "add.createCollection", "collection.submit"]);

function busy(dialog: ScreenDialog | null): boolean {
  if (dialog === null || dialog.kind === "detail") return false;
  return dialog.saving || (dialog.kind === "add" && dialog.creating !== null);
}

function sameName(collections: CollectionCreateResponse[], name: string): CollectionCreateResponse | undefined {
  const key = name.toLocaleLowerCase();
  return collections.find((collection) => collection.name.normalize("NFC").toLocaleLowerCase() === key);
}

function including(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id];
}

function upsert(products: ProductResponse[], product: ProductResponse): ProductResponse[] {
  return [product, ...products.filter((item) => item.id !== product.id)];
}

function replace(products: ProductResponse[], product: ProductResponse): ProductResponse[] {
  return products.map((item) => (item.id === product.id ? product : item));
}

const phaseOrder: Record<ProductResponse["metadata"]["phase"], number> = { queued: 0, running: 1, ready: 2, failed: 2 };

// A poll can arrive after a newer save or retry; only collection progress moves forward on screen.
function isLater(polled: ProductResponse["metadata"], shown: ProductResponse["metadata"]): boolean {
  if (polled.generation !== shown.generation) return polled.generation > shown.generation;
  return phaseOrder[polled.phase] >= phaseOrder[shown.phase];
}

function withProgress(products: ProductResponse[], polled: ProductResponse[]): ProductResponse[] {
  const latest = new Map(polled.map((product) => [product.id, product]));
  return products.map((product) => {
    const next = latest.get(product.id);
    if (!next || !isLater(next.metadata, product.metadata)) return product;
    return { ...product, title: next.title, metadata: next.metadata, lastSuccessfulPrice: next.lastSuccessfulPrice, picture: next.picture };
  });
}

function withDetailError(dialog: ScreenDialog | null, error: string | null): ScreenDialog | null {
  return dialog?.kind === "detail" ? { ...dialog, error } : dialog;
}

function onRetry(state: Ready, productId: string): Transition {
  const product = state.library.products.find((item) => item.id === productId);
  if (state.retrying !== null || state.refreshing || !product || !canRetry(product)) return stay(state);
  return {
    state: { ...state, retrying: productId, dialog: withDetailError(state.dialog, null) },
    call: { type: "metadata.retry", productId, body: { generation: product.metadata.generation } },
  };
}

function onRetried(state: Ready, outcome: ApiOutcome<MetadataRetryResponse>): Transition {
  const next: Ready = { ...state, retrying: null };
  if (outcome.ok) {
    return stay({ ...next, library: { ...next.library, products: replace(next.library.products, outcome.value.product) } });
  }
  const { failure } = outcome;
  if (failure.kind === "redirect") return leave(failure.to);
  const dialog = withDetailError(next.dialog, failure.message);
  if (failure.kind === "stale") return { state: { ...next, dialog, refreshing: true }, call: refresh };
  return stay({ ...next, dialog });
}

function withCollection(library: LibraryReadResponse, collection: CollectionCreateResponse): LibraryReadResponse {
  if (library.collections.some((item) => item.id === collection.id)) return library;
  return { ...library, collections: [...library.collections, collection] };
}

function settledLibrary(state: Ready, library: LibraryReadResponse): Ready {
  const ids = new Set(library.collections.map((collection) => collection.id));
  let dialog = state.dialog;
  if (dialog?.kind === "add") {
    dialog = { ...dialog, draft: { ...dialog.draft, collectionIds: dialog.draft.collectionIds.filter((id) => ids.has(id)) } };
  }
  if (dialog?.kind === "detail") {
    const { productId } = dialog;
    if (!library.products.some((product) => product.id === productId)) dialog = null;
  }
  return {
    ...state,
    library,
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
    case "filter":
      return stay({ ...state, collectionId: event.collectionId });
    case "add.open":
      if (busy(dialog)) return stay(state);
      return stay({ ...state, dialog: {
        kind: "add",
        draft: { url: "", option: "", collectionIds: state.collectionId ? [state.collectionId] : [] },
        saving: false,
        creating: null,
        error: null,
      } });
    case "collection.open":
      if (busy(dialog)) return stay(state);
      return stay({ ...state, dialog: { kind: "collection", name: "", saving: false, error: null } });
    case "detail.open":
      if (busy(dialog)) return stay(state);
      return stay({ ...state, dialog: { kind: "detail", productId: event.productId, arrival: null, error: null } });
    case "dialog.close":
      return busy(dialog) ? stay(state) : stay({ ...state, dialog: null });
    case "library.settled":
      if (event.outcome.ok) return stay(settledLibrary(state, event.outcome.value));
      return leaveOrStay({ ...state, refreshing: false }, event.outcome.failure);
    case "link.settled": {
      if (event.outcome.ok) {
        const { kind, product } = event.outcome.value;
        return stay({
          ...state,
          library: { ...state.library, products: upsert(state.library.products, product) },
          dialog: dialog?.kind === "add" ? { kind: "detail", productId: product.id, arrival: kind, error: null } : dialog,
        });
      }
      if (dialog?.kind !== "add") return leaveOrStay(state, event.outcome.failure);
      return failForm(state, event.outcome.failure, null, (error) => ({ ...dialog, saving: false, error }));
    }
    case "metadata.retry":
      return onRetry(state, event.productId);
    case "metadata.settled":
      return onRetried(state, event.outcome);
    case "poll":
      return { state, call: { type: "library.poll" } };
    case "poll.settled":
      if (event.outcome.ok) {
        return stay({ ...state, library: { ...state.library, products: withProgress(state.library.products, event.outcome.value.products) } });
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
        return stay({ phase: "ready", library: event.outcome.value, collectionId: null, dialog: null, refreshing: false, retrying: null });
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

export function visibleProducts(library: LibraryReadResponse, collectionId: string | null): ProductResponse[] {
  return library.products
    .filter((product) => collectionId === null || product.collectionIds.includes(collectionId))
    .sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
