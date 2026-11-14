"use client";

import { Copy, Smartphone } from "lucide-react";
import { SHARE_LINKS_PATH, shareLinkMessages } from "../../share/presentation/share-dto";
import { KeyPanel, useCopy, type KeyPanelText } from "./KeyPanel";
import type { KeyPanel as KeyPanelState } from "./key-panel-state";
import type { ScreenEvent } from "./screen-state";
import { shareConfirmView, shareKeyView, shareWithoutShortcuts, shortcutSteps } from "./share-view";

type Send = (event: ScreenEvent) => void;

// What the Shortcut can show after a share, in the words the route answers with.
const shortcutMessages = [
  shareLinkMessages.added,
  shareLinkMessages.duplicate,
  shareLinkMessages.invalid_link,
  shareLinkMessages.share_key_rejected,
  shareLinkMessages.share_key_busy,
];

const shareKeyText: KeyPanelText = {
  heading: "저장 키",
  checking: "저장 키를 확인하고 있어요…",
  working: "저장 키를 처리하는 중이에요…",
  create: "저장 키 만들기",
  describe: shareKeyView,
  confirm: shareConfirmView,
  secret: {
    label: "단축어의 Authorization 헤더 값",
    show: (secret) => `Bearer ${secret}`,
    copy: "헤더 값 복사",
    note: "이 키는 지금 한 번만 보여요. 이 화면을 떠나면 다시 볼 수 없어요. 잃어버리면 새 키로 바꾸면 돼요.",
  },
};

// The real share view. It sets up a Shortcut the owner builds by hand, and it cannot tell whether one exists: nothing
// here says the Shortcut is connected or installed.
export function ShareView({ panel, send }: { panel: KeyPanelState; send: Send }) {
  const { copy, status } = useCopy();
  const endpoint = new URL(SHARE_LINKS_PATH, window.location.origin).href;
  return (
    <section className="share-page share-setup" aria-label="iPhone 공유 단축어 설정">
      <div className="share-explanation">
        <span className="section-eyebrow">
          <Smartphone size={17} aria-hidden="true" />
          iPhone 공유 단축어
        </span>
        <h2>iPhone에서 바로 담기</h2>
        <p className="share-lead">
          앱을 오가지 않아도, 복사해두지 않아도.
          <br />
          쇼핑하던 곳에서 moti로 보내세요.
        </p>
        <ol className="setup-steps">
          <li>
            <span aria-hidden="true">1</span>
            <div>
              <h3>처음 한 번, 단축어 만들기</h3>
              <p>iPhone의 단축어 앱에서 아래 순서대로 직접 만들어요. 실제 iPhone에서 동작한 구성이에요. 동작 이름은 iOS 버전과 언어에 따라 조금 다를 수 있어요.</p>
              <ol className="shortcut-actions">
                {shortcutSteps.map((step) => <li key={step}>{step}</li>)}
              </ol>
              <div className="share-endpoint">
                <span className="share-key-label">단축어가 보낼 주소</span>
                <code>{endpoint}</code>
                <button className="button secondary" onClick={() => void copy("endpoint", endpoint)}>
                  <Copy size={16} aria-hidden="true" />
                  주소 복사
                </button>
                <p className="share-copy-status" role="status">{status("endpoint")}</p>
              </div>
            </div>
          </li>
          <li>
            <span aria-hidden="true">2</span>
            <div>
              <h3>마음에 드는 상품에서 공유</h3>
              <p>Safari나 쇼핑 앱의 공유 메뉴에서 ‘moti에 담기’ 단축어를 골라요.</p>
              <p>{shareWithoutShortcuts}</p>
            </div>
          </li>
          <li>
            <span aria-hidden="true">3</span>
            <div>
              <h3>담았다는 메시지만 확인</h3>
              <p>상품 정보는 moti를 열면 가져와요. 가져오지 못해도 링크는 남아요. 단축어는 이런 메시지를 보여줘요.</p>
              <ul className="share-messages">
                {shortcutMessages.map((message) => <li key={message}>{message}</li>)}
              </ul>
            </div>
          </li>
        </ol>
      </div>
      <KeyPanel panel={panel} endpoint="share" text={shareKeyText} send={send} />
    </section>
  );
}
