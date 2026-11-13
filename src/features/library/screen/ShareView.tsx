"use client";

import { Copy, Smartphone } from "lucide-react";
import { SHARE_LINKS_PATH, shareLinkMessages } from "../../share/presentation/share-dto";
import { KeyPanel, useCopy, type KeyPanelText } from "./KeyPanel";
import type { KeyPanel as KeyPanelState } from "./key-panel-state";
import type { ScreenEvent } from "./screen-state";
import { shareConfirmView, shareKeyView } from "./share-view";

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
              <p>iPhone의 단축어 앱에서 아래 순서대로 직접 만들어요. 동작 이름은 iOS 버전과 언어에 따라 조금 다를 수 있어요.</p>
              <ol className="shortcut-actions">
                <li>새 단축어 이름을 “moti에 담기”로 정하고, 설정에서 ‘공유 시트에서 보기’를 켜고 받을 항목을 URL과 Safari 웹 페이지로 골라요.</li>
                <li>‘입력에서 URL 가져오기’를 넣고, ‘목록에서 항목 가져오기’로 첫 번째 항목을 골라요.</li>
                <li>‘URL 콘텐츠 가져오기’를 넣고 아래 주소를 적은 뒤, 방법은 POST, 헤더는 Authorization, 요청 본문은 JSON으로 url에 2번의 항목을 넣어요.</li>
                <li>‘사전 값 가져오기’로 message를 꺼내 ‘알림 보기’로 보여 줘요.</li>
                <li>마지막으로 오른쪽(휴대폰에서는 아래)의 저장 키를 만들어 Authorization 헤더 값에 붙여 넣어요.</li>
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
