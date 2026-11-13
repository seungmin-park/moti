"use client";

import { useEffect, useId, useRef } from "react";
import { CircleAlert, Download, FileUp, Info, LoaderCircle } from "lucide-react";
import { Dialog } from "../../wishlist/Dialog";
import type { BackupCounts } from "../presentation/library-backup";
import type { BackupFile } from "./library-api";
import type { BackupNotice, BackupStep, ScreenEvent } from "./screen-state";

type Send = (event: ScreenEvent) => void;

const exportedTime = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const counted = ({ products, collections }: BackupCounts) => `상품 ${products}개 · 컬렉션 ${collections}개`;
const progress: Partial<Record<BackupStep["name"], string>> = {
  exporting: "백업을 만드는 중이에요…",
  reading: "파일을 확인하는 중이에요…",
  restoring: "보관함을 바꾸는 중이에요…",
};

function Notice({ notice }: { notice: BackupNotice | null }) {
  if (notice === null) return null;
  if (notice.kind === "error") {
    return (
      <p className="form-error" role="alert">
        <CircleAlert size={16} aria-hidden="true" />
        {notice.message}
      </p>
    );
  }
  return (
    <p className="form-note" role="status">
      <Info size={16} aria-hidden="true" />
      {notice.message}
    </p>
  );
}

function Menu({ notice, send }: { notice: BackupNotice | null; send: Send }) {
  const input = useRef<HTMLInputElement>(null);
  const exportId = useId();
  const restoreId = useId();
  return (
    <>
      <p className="dialog-intro">보관함을 파일 하나로 내려받아 두었다가 그 파일로 되돌릴 수 있어요.</p>
      <section className="backup-section" aria-labelledby={exportId}>
        <h3 id={exportId}>백업 만들기</h3>
        <p>상품·메모·컬렉션·구매 기록을 파일 하나로 내려받아요. 사진은 들어가지 않아요.</p>
        <button className="button secondary full" onClick={() => send({ type: "backup.export" })}>
          <Download size={16} aria-hidden="true" />
          백업 만들기
        </button>
      </section>
      <section className="backup-section" aria-labelledby={restoreId}>
        <h3 id={restoreId}>백업 파일로 복원</h3>
        <p>지금 보관함을 파일의 내용으로 바꿔요. 바꾸기 전에 한 번 더 확인해요.</p>
        <button className="button secondary full" onClick={() => input.current?.click()}>
          <FileUp size={16} aria-hidden="true" />
          백업 파일 선택
        </button>
        <input
          ref={input}
          className="sr-only"
          type="file"
          accept=".json,application/json"
          tabIndex={-1}
          aria-label="백업 파일"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) send({ type: "backup.choose", file });
          }}
        />
      </section>
      <Notice notice={notice} />
    </>
  );
}

// A real link the owner taps: iOS Safari downloads a blob from a user gesture, not after an await. The object URL is
// made and revoked by the same effect, so a remount never keeps a revoked one.
function Exported({ file, send }: { file: BackupFile; send: Send }) {
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([file.text], { type: "application/json" }));
    link.current?.setAttribute("href", url);
    link.current?.focus();
    return () => URL.revokeObjectURL(url);
  }, [file.text]);
  return (
    <>
      <p className="dialog-intro">백업 파일이 준비됐어요. 내려받아 안전한 곳에 보관해 주세요.</p>
      <p className="backup-summary">
        <strong>{file.name}</strong>
        <span>{counted(file.counts)}</span>
      </p>
      {!file.restorable && (
        <p className="form-note">
          <Info size={16} aria-hidden="true" />이 백업은 4MB를 넘어 지금은 한 번에 복원할 수 없어요.
        </p>
      )}
      <a ref={link} className="button primary full" download={file.name}>
        <Download size={16} aria-hidden="true" />
        내려받기
      </a>
      <button className="text-button backup-back" onClick={() => send({ type: "backup.back" })}>
        처음으로
      </button>
    </>
  );
}

function Confirm({ step, blocked, send }: { step: Extract<BackupStep, { name: "confirm" }>; blocked: boolean; send: Send }) {
  const emptied = step.incoming.products === 0 && step.current.products > 0;
  return (
    <>
      <p className="dialog-intro">지금 보관함을 백업 파일의 내용으로 바꿀까요?</p>
      <dl className="backup-compare">
        <div>
          <dt>지금 보관함</dt>
          <dd>{counted(step.current)}</dd>
        </div>
        <div>
          <dt>백업 파일 · {exportedTime.format(new Date(step.exportedAt))}</dt>
          <dd>{counted(step.incoming)}</dd>
        </div>
      </dl>
      {step.removed > 0 && <p className="backup-removed">백업에 없는 상품 {step.removed}개는 지워져요.</p>}
      {emptied && <p className="backup-removed">백업 파일에 상품이 없어요. 복원하면 보관함이 비어요.</p>}
      <p className="form-note">
        <Info size={16} aria-hidden="true" />
        링크가 같은 상품은 사진을 그대로 두고 이름·메모·컬렉션·구매 기록을 파일대로 바꿔요. 새 상품의 사진은 복원한 뒤 차례로 다시 가져와요.
      </p>
      <div className="backup-actions">
        <button className="button secondary" autoFocus onClick={() => send({ type: "backup.back" })}>
          취소
        </button>
        <button className="button primary" disabled={blocked} onClick={() => send({ type: "backup.restore" })}>
          보관함 바꾸기
        </button>
      </div>
    </>
  );
}

export function BackupDialog({ step, notice, blocked, send }: { step: BackupStep; notice: BackupNotice | null; blocked: boolean; send: Send }) {
  const working = progress[step.name];
  return (
    <Dialog title="백업과 복원" onClose={() => send({ type: "dialog.close" })}>
      <div className="backup-body" aria-busy={working !== undefined}>
        {working !== undefined && (
          <p className="backup-progress" role="status">
            <LoaderCircle size={16} aria-hidden="true" />
            {working}
          </p>
        )}
        {step.name === "menu" && <Menu notice={notice} send={send} />}
        {step.name === "exported" && <Exported file={step.file} send={send} />}
        {step.name === "confirm" && <Confirm step={step} blocked={blocked} send={send} />}
      </div>
    </Dialog>
  );
}
