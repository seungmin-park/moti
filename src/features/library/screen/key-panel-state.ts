import type {
  ShareKeyIssueResponse,
  ShareKeyReadResponse,
  ShareKeyResponse,
  ShareKeyRevokeResponse,
} from "../../share/presentation/share-dto";
import type { ApiFailure, ApiOutcome } from "./library-api";

// The owner's keys the screen manages. Each has its own endpoints; the panel logic is the same for all of them.
export type KeyEndpoint = "share";
// What reading each endpoint answers: always the key, sometimes more for the view around the panel.
type KeyReads = { share: ShareKeyReadResponse };
type KeyIssues = { share: ShareKeyIssueResponse };
type KeyRevokes = { share: ShareKeyRevokeResponse };
export type KeyResponse = ShareKeyResponse;
export type KeyConfirm = "rotate" | "revoke";
export type KeyNotice = { kind: "error" | "info"; message: string };
// One key's panel. The secret lives only here, and only until the owner says it is pasted, leaves the view or the page
// comes back from the back/forward cache (which reloads everything).
export type KeyPanel =
  | { status: "unread" }
  | { status: "loading" }
  | { status: "failed"; message: string }
  | {
    status: "ready";
    key: KeyResponse | null;
    secret: string | null;
    confirm: KeyConfirm | null;
    busy: boolean;
    notice: KeyNotice | null;
  };
export type KeyCall =
  | { type: "key.read"; endpoint: KeyEndpoint }
  | { type: "key.issue"; endpoint: KeyEndpoint; replaces: string | null }
  | { type: "key.revoke"; endpoint: KeyEndpoint; keyId: string };
type Settled<Type extends string, Values extends Record<KeyEndpoint, unknown>> = {
  [Endpoint in KeyEndpoint]: { type: Type; endpoint: Endpoint; outcome: ApiOutcome<Values[Endpoint]> };
}[KeyEndpoint];
export type KeyEvent =
  | { type: "key.retry"; endpoint: KeyEndpoint }
  | { type: "key.create"; endpoint: KeyEndpoint }
  | { type: "key.ask"; endpoint: KeyEndpoint; confirm: KeyConfirm }
  | { type: "key.cancel"; endpoint: KeyEndpoint }
  | { type: "key.confirm"; endpoint: KeyEndpoint }
  | { type: "key.pasted"; endpoint: KeyEndpoint }
  | Settled<"key.read.settled", KeyReads>
  | Settled<"key.issue.settled", KeyIssues>
  | Settled<"key.revoke.settled", KeyRevokes>;
// `leave` is the login address when the session ended.
export type KeyTransition = { panel: KeyPanel; call: KeyCall | null; leave: string | null };

type Ready = Extract<KeyPanel, { status: "ready" }>;

const keyEventTypes: ReadonlySet<string> = new Set<KeyEvent["type"]>([
  "key.retry", "key.create", "key.ask", "key.cancel", "key.confirm", "key.pasted",
  "key.read.settled", "key.issue.settled", "key.revoke.settled",
]);

export function isKeyEvent(event: { type: string }): event is KeyEvent {
  return keyEventTypes.has(event.type);
}

const stay = (panel: KeyPanel): KeyTransition => ({ panel, call: null, leave: null });
const settled = (key: KeyResponse | null, notice: KeyNotice | null = null): Ready =>
  ({ status: "ready", key, secret: null, confirm: null, busy: false, notice });
const isActive = (key: KeyResponse | null): key is KeyResponse => key !== null && key.revokedAt === null;

// Opening the panel reads the key again, so the last time the key was used is current.
export function openKeyPanel(panel: KeyPanel, endpoint: KeyEndpoint): KeyTransition {
  const read: KeyCall = { type: "key.read", endpoint };
  if (panel.status === "loading") return stay(panel);
  if (panel.status === "ready") return panel.busy ? stay(panel) : { panel, call: read, leave: null };
  return { panel: { status: "loading" }, call: read, leave: null };
}

// Leaving the panel forgets the secret and any open confirmation.
export function closeKeyPanel(panel: KeyPanel): KeyPanel {
  return panel.status === "ready" ? { ...panel, secret: null, confirm: null } : panel;
}

// A failed write re-reads, so the panel shows what the server has rather than what the screen guessed.
function failedWrite(panel: Ready, endpoint: KeyEndpoint, failure: ApiFailure, key: KeyResponse | null): KeyTransition {
  if (failure.kind === "redirect") return { panel, call: null, leave: failure.to };
  const notice: KeyNotice = { kind: failure.kind === "stale" ? "info" : "error", message: failure.message };
  if (failure.kind === "invalid") return stay(settled(key, notice));
  return { panel: settled(key, notice), call: { type: "key.read", endpoint }, leave: null };
}

// `visible` is whether the panel is on screen: a secret that arrives after the owner left is not kept.
export function onKeyPanel(panel: KeyPanel, event: KeyEvent, visible: boolean): KeyTransition {
  const { endpoint } = event;
  switch (event.type) {
    case "key.retry":
      return panel.status === "failed" ? openKeyPanel(panel, endpoint) : stay(panel);
    case "key.read.settled":
      if (panel.status === "loading") {
        if (event.outcome.ok) return stay(settled(event.outcome.value.key));
        const { failure } = event.outcome;
        return failure.kind === "redirect" ? { panel, call: null, leave: failure.to } : stay({ status: "failed", message: failure.message });
      }
      // A refresh never replaces an answer a write is about to give, and a failed refresh keeps what is shown.
      if (panel.status !== "ready" || panel.busy) return stay(panel);
      if (event.outcome.ok) return stay({ ...settled(event.outcome.value.key, panel.notice), secret: panel.secret });
      return event.outcome.failure.kind === "redirect" ? { panel, call: null, leave: event.outcome.failure.to } : stay(panel);
    default:
      break;
  }
  if (panel.status !== "ready") return stay(panel);
  switch (event.type) {
    case "key.create":
      if (panel.busy || isActive(panel.key)) return stay(panel);
      return { panel: { ...panel, busy: true, notice: null }, call: { type: "key.issue", endpoint, replaces: null }, leave: null };
    case "key.ask":
      if (panel.busy || panel.secret !== null || !isActive(panel.key)) return stay(panel);
      return stay({ ...panel, confirm: event.confirm, notice: null });
    case "key.cancel":
      return panel.busy ? stay(panel) : stay({ ...panel, confirm: null });
    case "key.confirm": {
      if (panel.busy || panel.confirm === null || !isActive(panel.key)) return stay(panel);
      const call: KeyCall = panel.confirm === "rotate"
        ? { type: "key.issue", endpoint, replaces: panel.key.id }
        : { type: "key.revoke", endpoint, keyId: panel.key.id };
      return { panel: { ...panel, busy: true, notice: null }, call, leave: null };
    }
    case "key.pasted":
      return stay({ ...panel, secret: null });
    case "key.issue.settled":
      if (!panel.busy) return stay(panel);
      if (event.outcome.ok) {
        const { key, secret } = event.outcome.value;
        return stay({ ...settled(key), secret: visible ? secret : null });
      }
      return failedWrite(panel, endpoint, event.outcome.failure, panel.key);
    case "key.revoke.settled":
      if (!panel.busy) return stay(panel);
      // Revoking by id is safe even if another device already rotated, but then a newer key is active: read it.
      if (event.outcome.ok) return { panel: settled(event.outcome.value.key), call: { type: "key.read", endpoint }, leave: null };
      return failedWrite(panel, endpoint, event.outcome.failure, panel.key);
    default:
      return stay(panel);
  }
}
