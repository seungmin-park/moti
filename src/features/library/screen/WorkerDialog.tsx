"use client";

import { useId, useState } from "react";
import { CircleAlert, Copy, Info } from "lucide-react";
import { Dialog } from "../../wishlist/Dialog";
import { WORKER_TOKEN_SECRET, WORKER_URL_VARIABLE, type WorkerRunResponse } from "../../worker/presentation/worker-dto";
import { KeyPanel, useCopy, type KeyPanelText } from "./KeyPanel";
import type { KeyPanel as KeyPanelState } from "./key-panel-state";
import type { ScreenEvent } from "./screen-state";
import { workerConfirmView, workerKeyView, workerRunView, workerSilence } from "./worker-view";

type Send = (event: ScreenEvent) => void;

const workerKeyText: KeyPanelText = {
  heading: "작업 키",
  checking: "작업 키를 확인하고 있어요…",
  working: "작업 키를 처리하는 중이에요…",
  create: "작업 키 만들기",
  describe: workerKeyView,
  confirm: workerConfirmView,
  secret: {
    label: `GitHub 비밀값 ${WORKER_TOKEN_SECRET}에 넣을 값`,
    show: (secret) => secret,
    copy: "키 복사",
    note: "이 키는 지금 한 번만 보여요. 이 창을 닫으면 다시 볼 수 없어요. 잃어버리면 새 키로 바꾸면 돼요.",
  },
};

function GitHubValues() {
  const { copy, status } = useCopy();
  const headingId = useId();
  const origin = window.location.origin;
  const rows = [
    { target: "secret", kind: "비밀값(Secret)", name: WORKER_TOKEN_SECRET, value: "위에서 만든 작업 키" },
    { target: "variable", kind: "변수(Variable)", name: WORKER_URL_VARIABLE, value: origin },
  ];
  return (
    <section className="worker-section" aria-labelledby={headingId}>
      <h3 id={headingId}>GitHub에 넣을 값</h3>
      <p>저장소의 Settings → Secrets and variables → Actions에서 아래 두 값을 넣어요. 둘 다 넣기 전에는 예약 실행이 아무것도 하지 않고 건너뛰어요.</p>
      <ul className="worker-values">
        {rows.map((row) => (
          <li key={row.name}>
            <span className="share-key-label">{row.kind}</span>
            <code>{row.name}</code>
            <span className="worker-value">{row.target === "variable" ? <code>{row.value}</code> : row.value}</span>
            <button className="button secondary" onClick={() => void copy(row.target, row.target === "variable" ? row.value : row.name)}>
              <Copy size={16} aria-hidden="true" />
              {row.target === "variable" ? "주소 복사" : "이름 복사"}
            </button>
            <p className="share-copy-status" role="status">{status(row.target)}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Runs({ panel, runs }: { panel: KeyPanelState; runs: WorkerRunResponse[] }) {
  const headingId = useId();
  // Read once when the dialog renders: the notice is about the record the owner is looking at.
  const [now] = useState(() => Date.now());
  const key = panel.status === "ready" ? panel.key : null;
  const silence = workerSilence(key, runs, now);
  return (
    <section className="worker-section" aria-labelledby={headingId}>
      <h3 id={headingId}>최근 실행</h3>
      {silence && (
        <p className="form-note" role="status">
          <Info size={16} aria-hidden="true" />
          {silence}
        </p>
      )}
      {runs.length === 0 ? (
        <p>아직 실행 기록이 없어요.</p>
      ) : (
        <ol className="worker-runs">
          {runs.map(workerRunView).map((run) => (
            <li key={run.id}>
              <p className="worker-run-head">
                <span>{run.when}</span>
                <span>{run.counts}</span>
              </p>
              <p className={run.failed ? "worker-run-state cut" : "worker-run-state"}>
                {run.failed && <CircleAlert size={14} aria-hidden="true" />}
                {run.state}
              </p>
              {run.failures.length > 0 && <p className="worker-run-failures">{run.failures.join(" · ")}</p>}
            </li>
          ))}
        </ol>
      )}
      <p className="form-note">
        <Info size={16} aria-hidden="true" />
        사진은 moti를 열 때 가져와요.
      </p>
    </section>
  );
}

// The scheduled worker's setup and record. Nothing here can tell whether GitHub is set up, so it never says so.
export function WorkerDialog({ panel, runs, send }: { panel: KeyPanelState; runs: WorkerRunResponse[]; send: Send }) {
  return (
    <Dialog title="자동 확인" onClose={() => send({ type: "dialog.close" })}>
      <p className="dialog-intro">
        하루 세 번(오전 6:17, 오후 2:17, 오후 10:17) GitHub Actions가 moti를 불러 아직 가져오지 못한 상품 정보를 가져와요.
        GitHub이 실행을 늦추거나 건너뛸 수 있어요.
      </p>
      <KeyPanel panel={panel} endpoint="worker" text={workerKeyText} send={send} />
      <GitHubValues />
      <Runs panel={panel} runs={runs} />
    </Dialog>
  );
}
