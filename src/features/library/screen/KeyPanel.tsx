"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { CircleAlert, Copy, Info, KeyRound, LoaderCircle } from "lucide-react";
import type { KeyConfirm, KeyEndpoint, KeyNotice, KeyPanel as KeyPanelState, KeyResponse } from "./key-panel-state";
import type { ScreenEvent } from "./screen-state";

type Send = (event: ScreenEvent) => void;
type Ready = Extract<KeyPanelState, { status: "ready" }>;

// The words one key's panel uses. The panel logic and layout are shared; what the key is for is not.
export type KeyPanelText = {
  heading: string;
  checking: string;
  working: string;
  create: string;
  describe(key: KeyResponse | null): { title: string; detail: string };
  confirm(confirm: KeyConfirm, key: KeyResponse): { message: string; action: string };
  secret: { label: string; show(secret: string): string; copy: string; note: string };
};

// The clipboard needs a secure context and a permission; when it refuses, the text stays selectable.
export function useCopy() {
  const [copied, setCopied] = useState<{ target: string; ok: boolean } | null>(null);
  async function copy(target: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied({ target, ok: true });
    } catch {
      setCopied({ target, ok: false });
    }
  }
  const status = (target: string) => {
    if (copied?.target !== target) return null;
    return copied.ok ? "복사했어요." : "복사하지 못했어요. 글자를 길게 눌러 직접 복사해 주세요.";
  };
  return { copy, status };
}

function Notice({ notice }: { notice: KeyNotice | null }) {
  if (notice === null) return null;
  return notice.kind === "error" ? (
    <p className="form-error" role="alert">
      <CircleAlert size={16} aria-hidden="true" />
      {notice.message}
    </p>
  ) : (
    <p className="form-note share-notice" role="status">
      <Info size={16} aria-hidden="true" />
      {notice.message}
    </p>
  );
}

function Secret({ secret, endpoint, text, send }: { secret: string; endpoint: KeyEndpoint; text: KeyPanelText["secret"]; send: Send }) {
  const { copy, status } = useCopy();
  const shown = text.show(secret);
  return (
    <div className="share-secret-block">
      <p className="share-key-label">{text.label}</p>
      <code className="share-secret">{shown}</code>
      <button className="button secondary full" autoFocus onClick={() => void copy("secret", shown)}>
        <Copy size={16} aria-hidden="true" />
        {text.copy}
      </button>
      <p className="share-copy-status" role="status">{status("secret")}</p>
      <p className="form-note">
        <Info size={16} aria-hidden="true" />
        {text.note}
      </p>
      <button className="button primary full" onClick={() => send({ type: "key.pasted", endpoint })}>
        붙여 넣었어요
      </button>
    </div>
  );
}

function Confirm({ panel, endpoint, confirm, text, send }: {
  panel: Ready & { key: NonNullable<Ready["key"]> };
  endpoint: KeyEndpoint;
  confirm: KeyConfirm;
  text: KeyPanelText;
  send: Send;
}) {
  const messageId = useId();
  const { message, action } = text.confirm(confirm, panel.key);
  const cancelOnEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    send({ type: "key.cancel", endpoint });
  };
  return (
    <div className="share-confirm" role="group" aria-labelledby={messageId} onKeyDown={cancelOnEscape}>
      <p id={messageId}>{message}</p>
      <div className="share-key-actions">
        <button className="button secondary" autoFocus disabled={panel.busy} onClick={() => send({ type: "key.cancel", endpoint })}>
          취소
        </button>
        <button className="button primary" disabled={panel.busy} onClick={() => send({ type: "key.confirm", endpoint })}>
          {action}
        </button>
      </div>
    </div>
  );
}

function KeyState({ panel, endpoint, text, section, send }: {
  panel: Ready;
  endpoint: KeyEndpoint;
  text: KeyPanelText;
  section: RefObject<HTMLElement | null>;
  send: Send;
}) {
  const rotate = useRef<HTMLButtonElement>(null);
  const revoke = useRef<HTMLButtonElement>(null);
  const asked = useRef<KeyConfirm | null>(null);
  const { key, confirm, busy } = panel;
  // A closed confirmation hands focus back to the button that opened it, or to the next action when it is gone.
  useEffect(() => {
    if (confirm !== null) {
      asked.current = confirm;
      return;
    }
    const last = asked.current;
    asked.current = null;
    if (last === null) return;
    const opener = last === "rotate" ? rotate.current : revoke.current;
    (opener ?? section.current?.querySelector<HTMLElement>(".button"))?.focus();
  }, [confirm, section]);
  const view = text.describe(key);
  const active = key !== null && key.revokedAt === null;
  return (
    <>
      <p className="share-key-title">{view.title}</p>
      <p className="share-key-detail">{view.detail}</p>
      {active && confirm !== null ? (
        <Confirm panel={{ ...panel, key }} endpoint={endpoint} confirm={confirm} text={text} send={send} />
      ) : active ? (
        <div className="share-key-actions">
          <button ref={rotate} className="button secondary" disabled={busy} onClick={() => send({ type: "key.ask", endpoint, confirm: "rotate" })}>
            새 키로 바꾸기
          </button>
          <button ref={revoke} className="button secondary" disabled={busy} onClick={() => send({ type: "key.ask", endpoint, confirm: "revoke" })}>
            키 폐기
          </button>
        </div>
      ) : (
        <button className="button primary full" disabled={busy} onClick={() => send({ type: "key.create", endpoint })}>
          {text.create}
        </button>
      )}
      {busy && (
        <p className="share-key-progress" role="status">
          <LoaderCircle size={16} aria-hidden="true" />
          {text.working}
        </p>
      )}
    </>
  );
}

export function KeyPanel({ panel, endpoint, text, send }: { panel: KeyPanelState; endpoint: KeyEndpoint; text: KeyPanelText; send: Send }) {
  const titleId = useId();
  const section = useRef<HTMLElement>(null);
  const showing = panel.status === "ready" && panel.secret !== null;
  const shown = useRef(showing);
  // The secret block takes the focus when it appears; when it goes, the focus stays in the panel.
  useEffect(() => {
    if (shown.current && !showing) section.current?.querySelector<HTMLElement>(".button")?.focus();
    shown.current = showing;
  }, [showing]);
  return (
    <section ref={section} className="share-key-panel" aria-labelledby={titleId}>
      <h3 id={titleId}>
        <KeyRound size={17} aria-hidden="true" />
        {text.heading}
      </h3>
      {(panel.status === "unread" || panel.status === "loading") && (
        <p className="share-key-progress" role="status">
          <LoaderCircle size={16} aria-hidden="true" />
          {text.checking}
        </p>
      )}
      {panel.status === "failed" && (
        <>
          <p className="form-error" role="alert">
            <CircleAlert size={16} aria-hidden="true" />
            {panel.message}
          </p>
          <button className="button secondary full" onClick={() => send({ type: "key.retry", endpoint })}>
            다시 불러오기
          </button>
        </>
      )}
      {panel.status === "ready" && (
        <>
          <Notice notice={panel.notice} />
          {panel.secret !== null
            ? <Secret secret={panel.secret} endpoint={endpoint} text={text.secret} send={send} />
            : <KeyState panel={panel} endpoint={endpoint} text={text} section={section} send={send} />}
        </>
      )}
    </section>
  );
}
