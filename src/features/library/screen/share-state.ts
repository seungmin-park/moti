import type {
  ShareKeyIssueResponse,
  ShareKeyReadResponse,
  ShareKeyResponse,
  ShareKeyRevokeResponse,
} from "../../share/presentation/share-dto";
import type { ApiFailure, ApiOutcome } from "./library-api";

export type ShareConfirm = "rotate" | "revoke";
export type ShareNotice = { kind: "error" | "info"; message: string };
// The share view's key panel. The secret lives only here, and only until the owner says it is pasted, leaves the view
// or the page comes back from the back/forward cache (which reloads everything).
export type SharePanel =
  | { status: "unread" }
  | { status: "loading" }
  | { status: "failed"; message: string }
  | {
    status: "ready";
    key: ShareKeyResponse | null;
    secret: string | null;
    confirm: ShareConfirm | null;
    busy: boolean;
    notice: ShareNotice | null;
  };
export type ShareCall =
  | { type: "share.read" }
  | { type: "share.issue"; replaces: string | null }
  | { type: "share.revoke"; keyId: string };
export type ShareEvent =
  | { type: "share.retry" }
  | { type: "share.create" }
  | { type: "share.ask"; confirm: ShareConfirm }
  | { type: "share.cancel" }
  | { type: "share.confirm" }
  | { type: "share.pasted" }
  | { type: "share.read.settled"; outcome: ApiOutcome<ShareKeyReadResponse> }
  | { type: "share.issue.settled"; outcome: ApiOutcome<ShareKeyIssueResponse> }
  | { type: "share.revoke.settled"; outcome: ApiOutcome<ShareKeyRevokeResponse> };
// `leave` is the login address when the session ended.
export type ShareTransition = { panel: SharePanel; call: ShareCall | null; leave: string | null };

type Ready = Extract<SharePanel, { status: "ready" }>;

const shareEventTypes: ReadonlySet<string> = new Set<ShareEvent["type"]>([
  "share.retry", "share.create", "share.ask", "share.cancel", "share.confirm", "share.pasted",
  "share.read.settled", "share.issue.settled", "share.revoke.settled",
]);

export function isShareEvent(event: { type: string }): event is ShareEvent {
  return shareEventTypes.has(event.type);
}

const stay = (panel: SharePanel): ShareTransition => ({ panel, call: null, leave: null });
const settled = (key: ShareKeyResponse | null, notice: ShareNotice | null = null): Ready =>
  ({ status: "ready", key, secret: null, confirm: null, busy: false, notice });
const isActive = (key: ShareKeyResponse | null): key is ShareKeyResponse => key !== null && key.revokedAt === null;

// Opening the view reads the key again, so the last time the Shortcut used it is current.
export function openShare(panel: SharePanel): ShareTransition {
  if (panel.status === "loading") return stay(panel);
  if (panel.status === "ready") return panel.busy ? stay(panel) : { panel, call: { type: "share.read" }, leave: null };
  return { panel: { status: "loading" }, call: { type: "share.read" }, leave: null };
}

// Leaving the view forgets the secret and any open confirmation.
export function closeShare(panel: SharePanel): SharePanel {
  return panel.status === "ready" ? { ...panel, secret: null, confirm: null } : panel;
}

// A failed write re-reads, so the panel shows what the server has rather than what the screen guessed.
function failedWrite(panel: Ready, failure: ApiFailure, key: ShareKeyResponse | null): ShareTransition {
  if (failure.kind === "redirect") return { panel, call: null, leave: failure.to };
  const notice: ShareNotice = { kind: failure.kind === "stale" ? "info" : "error", message: failure.message };
  if (failure.kind === "invalid") return stay(settled(key, notice));
  return { panel: settled(key, notice), call: { type: "share.read" }, leave: null };
}

// `visible` is whether the share view is on screen: a secret that arrives after the owner left is not kept.
export function onShare(panel: SharePanel, event: ShareEvent, visible: boolean): ShareTransition {
  switch (event.type) {
    case "share.retry":
      return panel.status === "failed" ? openShare(panel) : stay(panel);
    case "share.read.settled":
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
    case "share.create":
      if (panel.busy || isActive(panel.key)) return stay(panel);
      return { panel: { ...panel, busy: true, notice: null }, call: { type: "share.issue", replaces: null }, leave: null };
    case "share.ask":
      if (panel.busy || panel.secret !== null || !isActive(panel.key)) return stay(panel);
      return stay({ ...panel, confirm: event.confirm, notice: null });
    case "share.cancel":
      return panel.busy ? stay(panel) : stay({ ...panel, confirm: null });
    case "share.confirm": {
      if (panel.busy || panel.confirm === null || !isActive(panel.key)) return stay(panel);
      const call: ShareCall = panel.confirm === "rotate"
        ? { type: "share.issue", replaces: panel.key.id }
        : { type: "share.revoke", keyId: panel.key.id };
      return { panel: { ...panel, busy: true, notice: null }, call, leave: null };
    }
    case "share.pasted":
      return stay({ ...panel, secret: null });
    case "share.issue.settled":
      if (!panel.busy) return stay(panel);
      if (event.outcome.ok) {
        const { key, secret } = event.outcome.value;
        return stay({ ...settled(key), secret: visible ? secret : null });
      }
      return failedWrite(panel, event.outcome.failure, panel.key);
    case "share.revoke.settled":
      if (!panel.busy) return stay(panel);
      // Revoking by id is safe even if another device already rotated, but then a newer key is active: read it.
      if (event.outcome.ok) return { panel: settled(event.outcome.value.key), call: { type: "share.read" }, leave: null };
      return failedWrite(panel, event.outcome.failure, panel.key);
    default:
      return stay(panel);
  }
}
