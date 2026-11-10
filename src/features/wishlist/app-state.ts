import { reduceSession, type Command, type Session } from "./model";

export type Modal =
  | { kind: "add"; collectionIds: string[] }
  | { kind: "detail"; id: string }
  | { kind: "collection"; id?: string }
  | { kind: "share" };

export type AppState = { session: Session; modal: Modal | null };

export type AppAction =
  | { type: "domain"; command: Command }
  | { type: "open"; modal: Modal }
  | { type: "close" }
  | { type: "add.collection.toggle"; id: string }
  | { type: "add.collection.create"; name: string };

export function reduceApp(state: AppState, action: AppAction): AppState {
  if (action.type === "add.collection.create") {
    if (state.modal?.kind !== "add") return state;
    const session = reduceSession(state.session, {
      type: "collection.create",
      name: action.name,
    });
    const result = session.feedback;
    return {
      session,
      modal: result?.kind === "collection-created"
        ? {
            kind: "add",
            collectionIds: [...new Set([...state.modal.collectionIds, result.collectionId])],
          }
        : state.modal,
    };
  }
  if (action.type === "add.collection.toggle") {
    if (
      state.modal?.kind !== "add" ||
      !state.session.collections.some((collection) => collection.id === action.id)
    ) return state;
    const selected = state.modal.collectionIds;
    return {
      ...state,
      modal: {
        kind: "add",
        collectionIds: selected.includes(action.id)
          ? selected.filter((id) => id !== action.id)
          : [...selected, action.id],
      },
    };
  }
  if (action.type === "open")
    return {
      session: reduceSession(state.session, { type: "feedback.dismiss" }),
      modal: action.modal,
    };
  if (action.type === "close")
    return {
      session: reduceSession(state.session, { type: "feedback.dismiss" }),
      modal: null,
    };
  const session = reduceSession(state.session, action.command);
  let modal = state.modal;
  if (
    session.feedback?.kind === "added" ||
    session.feedback?.kind === "duplicate"
  )
    modal = { kind: "detail", id: session.feedback.productId };
  if (
    session.feedback?.kind !== "invalid" &&
    [
      "product.purchase",
      "product.restore",
      "collection.create",
      "collection.rename",
    ].includes(action.command.type)
  )
    modal = null;
  return { session, modal };
}
