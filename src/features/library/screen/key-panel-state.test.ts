import { describe, expect, it } from "vitest";
import type { ShareKeyResponse } from "../../share/presentation/share-dto";
import type { ApiFailure } from "./library-api";
import { closeKeyPanel, onKeyPanel, openKeyPanel, type KeyPanel } from "./key-panel-state";

const key: ShareKeyResponse = {
  id: "55555555-5555-4555-8555-555555555555",
  hint: "a1B2",
  createdAt: "2026-11-13T05:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
};
const revoked: ShareKeyResponse = { ...key, revokedAt: "2026-11-13T06:00:00.000Z" };
const next: ShareKeyResponse = { ...key, id: "66666666-6666-4666-8666-666666666666", hint: "Zz9_" };
const secret = `moti_sk_${"AbcdEfghIjklMnopQrstUvwxYz0123456789-_AZz9_"}`;
const unavailable: ApiFailure = { kind: "unavailable", message: "연결을 확인하고 다시 시도해 주세요." };
const changed: ApiFailure = { kind: "stale", message: "다른 곳에서 키가 바뀌었어요. 최신 상태를 불러왔어요." };

type Ready = Extract<KeyPanel, { status: "ready" }>;
const ready = (overrides: Partial<Ready> = {}): Ready =>
  ({ status: "ready", key, secret: null, confirm: null, busy: false, notice: null, ...overrides });
const read = { type: "key.read", endpoint: "share" } as const;

describe("공유 저장 키 패널 열기", () => {
  it("Given 처음 여는 보기 When 열면 Then 불러오는 중이고 키를 읽는다", () => {
    expect(openKeyPanel({ status: "unread" }, "share")).toEqual({ panel: { status: "loading" }, call: read, leave: null });
  });

  it("Given 이미 읽은 패널 When 다시 열면 Then 보이는 키를 두고 마지막 사용 시각을 다시 읽는다", () => {
    expect(openKeyPanel(ready(), "share")).toEqual({ panel: ready(), call: read, leave: null });
  });

  it("Given 읽는 중이거나 키를 바꾸는 중 When 다시 열면 Then 요청을 겹치지 않는다", () => {
    expect(openKeyPanel({ status: "loading" }, "share")).toEqual({ panel: { status: "loading" }, call: null, leave: null });
    expect(openKeyPanel(ready({ busy: true }), "share")).toEqual({ panel: ready({ busy: true }), call: null, leave: null });
  });

  it("Given 불러오는 중 When 키가 없다는 답 Then 키 없음 패널이고, 실패하면 안내와 다시 불러오기를 준다", () => {
    expect(onKeyPanel({ status: "loading" }, { type: "key.read.settled", endpoint: "share", outcome: { ok: true, value: { key: null } } }, true).panel)
      .toEqual(ready({ key: null }));
    const failed = onKeyPanel({ status: "loading" }, { type: "key.read.settled", endpoint: "share", outcome: { ok: false, failure: unavailable } }, true);
    expect(failed.panel).toEqual({ status: "failed", message: unavailable.message });
    expect(onKeyPanel(failed.panel, { type: "key.retry", endpoint: "share" }, true)).toEqual({ panel: { status: "loading" }, call: read, leave: null });
  });

  it("Given 세션이 끝남 When 키를 읽으면 Then 로그인으로 떠난다", () => {
    const outcome = { ok: false as const, failure: { kind: "redirect" as const, to: "/login" } };
    expect(onKeyPanel({ status: "loading" }, { type: "key.read.settled", endpoint: "share", outcome }, true).leave).toBe("/login");
  });
});

describe("엔드포인트", () => {
  it("Given 작업 키 패널 When 열고 만들고 폐기하면 Then 모든 요청이 작업 키 엔드포인트로 간다", () => {
    expect(openKeyPanel({ status: "unread" }, "worker").call).toEqual({ type: "key.read", endpoint: "worker" });
    expect(onKeyPanel(ready({ key: null }), { type: "key.create", endpoint: "worker" }, true).call)
      .toEqual({ type: "key.issue", endpoint: "worker", replaces: null });
    expect(onKeyPanel(ready({ confirm: "revoke" }), { type: "key.confirm", endpoint: "worker" }, true).call)
      .toEqual({ type: "key.revoke", endpoint: "worker", keyId: key.id });
    expect(onKeyPanel(ready({ confirm: "revoke", busy: true }), { type: "key.revoke.settled", endpoint: "worker", outcome: { ok: true, value: { key: revoked } } }, true).call)
      .toEqual({ type: "key.read", endpoint: "worker" });
  });
});

describe("저장 키 만들기", () => {
  it.each([["키 없음", null], ["폐기한 키", revoked]])("Given %s When 만들면 Then 바꿀 키 없이 만들기를 요청한다", (_name, shown) => {
    expect(onKeyPanel(ready({ key: shown }), { type: "key.create", endpoint: "share" }, true))
      .toEqual({ panel: ready({ key: shown, busy: true }), call: { type: "key.issue", endpoint: "share", replaces: null }, leave: null });
  });

  it("Given 활성 키 When 만들기를 누르면 Then 바로 만들지 않는다", () => {
    expect(onKeyPanel(ready(), { type: "key.create", endpoint: "share" }, true)).toEqual({ panel: ready(), call: null, leave: null });
  });

  it("Given 만드는 중 When 비밀을 받으면 Then 새 키와 비밀을 한 번 보여주고, 붙여 넣었다고 하면 비밀을 지운다", () => {
    const shown = onKeyPanel(ready({ key: null, busy: true }), { type: "key.issue.settled", endpoint: "share", outcome: { ok: true, value: { key: next, secret } } }, true);
    expect(shown.panel).toEqual(ready({ key: next, secret }));
    expect(shown.call).toEqual({ type: "key.read", endpoint: "share" });
    expect(onKeyPanel(shown.panel, { type: "key.pasted", endpoint: "share" }, true).panel).toEqual(ready({ key: next }));
  });

  it("Given 만드는 중 보기를 떠남 When 비밀을 받으면 Then 키만 남기고 비밀은 버린다", () => {
    const { panel } = onKeyPanel(ready({ key: null, busy: true }), { type: "key.issue.settled", endpoint: "share", outcome: { ok: true, value: { key: next, secret } } }, false);
    expect(panel).toEqual(ready({ key: next }));
  });

  it("Given 비밀이 보이는 패널 When 보기를 떠나면 Then 비밀과 열린 확인을 지운다", () => {
    expect(closeKeyPanel(ready({ key: next, secret }))).toEqual(ready({ key: next }));
    expect(closeKeyPanel(ready({ confirm: "revoke" }))).toEqual(ready());
    expect(closeKeyPanel({ status: "loading" })).toEqual({ status: "loading" });
  });

  it("Given 만드는 중 When 앞서 보낸 읽기 결과가 오면 Then 무시하고 만들기 결과를 기다린다", () => {
    const busy = ready({ key: null, busy: true });
    expect(onKeyPanel(busy, { type: "key.read.settled", endpoint: "share", outcome: { ok: true, value: { key: revoked } } }, true).panel).toEqual(busy);
  });
});

describe("새 키로 바꾸기와 폐기", () => {
  it("Given 활성 키 When 새 키로 바꾸기를 물으면 Then 확인을 열고, 취소하면 닫고, 확인하면 화면이 본 키를 바꿀 키로 보낸다", () => {
    const asked = onKeyPanel(ready(), { type: "key.ask", endpoint: "share", confirm: "rotate" }, true).panel;
    expect(asked).toEqual(ready({ confirm: "rotate" }));
    expect(onKeyPanel(asked, { type: "key.cancel", endpoint: "share" }, true).panel).toEqual(ready());
    expect(onKeyPanel(asked, { type: "key.confirm", endpoint: "share" }, true))
      .toEqual({ panel: ready({ confirm: "rotate", busy: true }), call: { type: "key.issue", endpoint: "share", replaces: key.id }, leave: null });
  });

  it("Given 활성 키 When 폐기를 확인하면 Then 그 키를 폐기하고, 결과로 폐기한 키를 보인 뒤 다른 곳에서 만든 키가 있는지 다시 읽는다", () => {
    const confirmed = onKeyPanel(ready({ confirm: "revoke" }), { type: "key.confirm", endpoint: "share" }, true);
    expect(confirmed).toEqual({ panel: ready({ confirm: "revoke", busy: true }), call: { type: "key.revoke", endpoint: "share", keyId: key.id }, leave: null });
    const done = onKeyPanel(confirmed.panel, { type: "key.revoke.settled", endpoint: "share", outcome: { ok: true, value: { key: revoked } } }, true);
    expect(done).toEqual({ panel: ready({ key: revoked }), call: { type: "key.read", endpoint: "share" }, leave: null });
    // Another device already replaced the key this tab revoked: the read shows that newer key is still active.
    expect(onKeyPanel(done.panel, { type: "key.read.settled", endpoint: "share", outcome: { ok: true, value: { key: next } } }, true).panel)
      .toEqual(ready({ key: next }));
  });

  it("Given 비밀이 보이거나 키가 없거나 폐기된 패널 When 바꾸기·폐기를 물으면 Then 확인을 열지 않는다", () => {
    for (const panel of [ready({ secret }), ready({ key: null }), ready({ key: revoked }), ready({ busy: true })]) {
      expect(onKeyPanel(panel, { type: "key.ask", endpoint: "share", confirm: "revoke" }, true).panel).toEqual(panel);
    }
  });

  it("Given 바꾸는 중 When 취소하면 Then 무시한다", () => {
    const busy = ready({ confirm: "rotate", busy: true });
    expect(onKeyPanel(busy, { type: "key.cancel", endpoint: "share" }, true).panel).toEqual(busy);
  });

  it("Given 다른 곳에서 키가 바뀜 When 바꾸거나 폐기하면 Then 안내를 남기고 다시 읽으며, 읽은 뒤에도 안내가 남는다", () => {
    const rotated = onKeyPanel(ready({ confirm: "rotate", busy: true }), { type: "key.issue.settled", endpoint: "share", outcome: { ok: false, failure: changed } }, true);
    expect(rotated).toEqual({ panel: ready({ notice: { kind: "info", message: changed.message } }), call: read, leave: null });
    const reread = onKeyPanel(rotated.panel, { type: "key.read.settled", endpoint: "share", outcome: { ok: true, value: { key: next } } }, true);
    expect(reread.panel).toEqual(ready({ key: next, notice: { kind: "info", message: changed.message } }));
  });

  it("Given 연결 실패 When 폐기하면 Then 오류 안내를 남기고 실제 상태를 다시 읽는다", () => {
    const failed = onKeyPanel(ready({ confirm: "revoke", busy: true }), { type: "key.revoke.settled", endpoint: "share", outcome: { ok: false, failure: unavailable } }, true);
    expect(failed).toEqual({ panel: ready({ notice: { kind: "error", message: unavailable.message } }), call: read, leave: null });
  });

  it("Given 세션이 끝남 When 키를 만들면 Then 로그인으로 떠난다", () => {
    const outcome = { ok: false as const, failure: { kind: "redirect" as const, to: "/login?error=forbidden" } };
    expect(onKeyPanel(ready({ busy: true }), { type: "key.issue.settled", endpoint: "share", outcome }, true).leave).toBe("/login?error=forbidden");
  });
});
