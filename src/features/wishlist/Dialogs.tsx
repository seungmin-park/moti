"use client";

import Image from "next/image";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  Bookmark,
  Check,
  CheckCheck,
  CircleAlert,
  Link2,
  LoaderCircle,
  RotateCcw,
  X,
} from "lucide-react";
import { formatPrice, type Command, type Product, type Session } from "./model";

export type Modal =
  | { kind: "add"; collectionId?: string }
  | { kind: "detail"; id: string }
  | { kind: "collection"; id?: string }
  | { kind: "share" };
export type AppAction =
  | { type: "domain"; command: Command }
  | { type: "open"; modal: Modal }
  | { type: "close" };

function Dialog({
  title,
  wide = false,
  onClose,
  children,
}: {
  title: string;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const dialog = ref.current;
    dialog?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog?.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
      else
        document.querySelector<HTMLElement>("[data-focus-fallback]")?.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? "detail-dialog" : ""}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="dialog-heading">
        <h2 id={titleId}>{title}</h2>
        <button className="icon-button" aria-label="닫기" onClick={onClose}>
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

function Feedback({ session }: { session: Session }) {
  if (!session.feedback) return null;
  if (session.feedback.kind === "invalid")
    return (
      <p className="form-error" role="alert">
        <CircleAlert size={16} />
        {session.feedback.message}
      </p>
    );
  if (session.feedback.kind === "changed")
    return (
      <p className="form-success" role="status">
        <Check size={16} />
        {session.feedback.message}
      </p>
    );
  return null;
}

function AddLink({
  session,
  collectionId,
  dispatch,
  onClose,
}: {
  session: Session;
  collectionId?: string;
  dispatch: Dispatch<AppAction>;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [option, setOption] = useState("");
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<string[]>(
    collectionId ? [collectionId] : [],
  );
  return (
    <Dialog title="마음에 든 물건을 담아두세요" onClose={onClose}>
      <p className="dialog-intro">쇼핑하다 발견한 상품 링크 하나면 충분해요.</p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          dispatch({
            type: "domain",
            command: {
              type: "link.add",
              url,
              option,
              at: new Date().toISOString(),
              collectionIds: selectedCollectionIds,
            },
          });
        }}
      >
        <label className="field">
          <span>상품 링크</span>
          <div className="input-icon">
            <Link2 size={18} />
            <input
              autoFocus
              type="url"
              inputMode="url"
              placeholder="https://shop.com/product"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              maxLength={4096}
            />
          </div>
        </label>
        <label className="field">
          <span>
            옵션 <small>선택</small>
          </span>
          <input
            placeholder="예: 크림 · 250mm"
            value={option}
            onChange={(event) => setOption(event.target.value)}
            maxLength={120}
          />
        </label>
        <p className="field-help">
          다른 색상이나 사이즈는 따로 담아둘 수 있어요.
        </p>
        <fieldset className="collection-options add-collections">
          <legend>
            담을 컬렉션 <small>선택 · 여러 개 가능</small>
          </legend>
          {session.collections.map((collection) => (
            <label key={collection.id}>
              <input
                type="checkbox"
                checked={selectedCollectionIds.includes(collection.id)}
                onChange={(event) =>
                  setSelectedCollectionIds((selected) =>
                    event.target.checked
                      ? [...selected, collection.id]
                      : selected.filter((id) => id !== collection.id),
                  )
                }
              />
              <span>{collection.name}</span>
            </label>
          ))}
          <p className="collection-help">
            고르지 않으면 위시리스트에만 담아요.
          </p>
        </fieldset>
        <Feedback session={session} />
        <div className="form-note">
          <Bookmark size={17} />
          <p>
            이 목업에서는 링크를 현재 화면에만 보관해요.
            <br />
            상품 정보 수집은 다음 화면에서 예시로 체험해요.
          </p>
        </div>
        <button className="button primary full" type="submit">
          위시에 담기 <ArrowUpRight size={17} />
        </button>
      </form>
    </Dialog>
  );
}

function CollectionForm({
  session,
  id,
  dispatch,
  onClose,
}: {
  session: Session;
  id?: string;
  dispatch: Dispatch<AppAction>;
  onClose: () => void;
}) {
  const [name, setName] = useState(
    session.collections.find((c) => c.id === id)?.name ?? "",
  );
  return (
    <Dialog
      title={id ? "컬렉션 이름 바꾸기" : "새로운 컬렉션"}
      onClose={onClose}
    >
      <p className="dialog-intro">함께 두고 싶은 물건들에 이름을 붙여주세요.</p>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          dispatch({
            type: "domain",
            command: id
              ? { type: "collection.rename", id, name }
              : { type: "collection.create", name },
          });
        }}
      >
        <label className="field">
          <span>컬렉션 이름</span>
          <input
            autoFocus
            placeholder="예: 오래 머물고 싶은 방"
            maxLength={40}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <Feedback session={session} />
        <button className="button primary full" type="submit">
          {id ? "이름 저장" : "만들기"}
        </button>
      </form>
    </Dialog>
  );
}

function Detail({
  product,
  session,
  dispatch,
  onClose,
}: {
  product: Product;
  session: Session;
  dispatch: Dispatch<AppAction>;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(product.title);
  const [note, setNote] = useState(product.note);
  const [collectionIds, setCollectionIds] = useState(product.collectionIds);
  const [date, setDate] = useState(
    product.purchase.status === "purchased"
      ? (product.purchase.date ?? "")
      : "",
  );
  const [paid, setPaid] = useState(
    product.purchase.status === "purchased" && product.purchase.price !== null
      ? String(product.purchase.price)
      : "",
  );
  const send = (command: Command) => dispatch({ type: "domain", command });
  const metadata = product.metadata;
  const purchased = product.purchase.status === "purchased";
  return (
    <Dialog title="담아둔 물건" wide onClose={onClose}>
      {session.feedback?.kind === "duplicate" && (
        <p className="duplicate-notice">
          <CheckCheck size={18} />
          이미 담아둔 상품이에요
        </p>
      )}
      <div className="detail-body">
        <div className="detail-visual">
          <div className="detail-picture">
            {product.image ? (
              <Image
                src={product.image}
                alt={product.title}
                width={800}
                height={800}
                sizes="(max-width:640px) 90vw, 400px"
              />
            ) : (
              <div className="picture-placeholder">
                <Link2 size={40} />
                <span>원본 링크를 보관했어요</span>
              </div>
            )}
          </div>
          <a
            className="button secondary original-link"
            href={product.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            원본 링크 열기 <ArrowUpRight size={17} />
          </a>
          <p className="source-url">{product.sourceUrl}</p>
          <p className="small-muted">
            상품 이미지·가격·쇼핑몰 정보는 목업용 예시예요.
          </p>
        </div>
        <div className="detail-info">
          <span className="shop-name">{product.shop}</span>
          <h3>{product.title}</h3>
          <p className="detail-option">{product.option || "옵션 미입력"}</p>
          {metadata.phase === "ready" ? (
            <div className="detail-price">
              <strong>{formatPrice(metadata.price)}</strong>
              <span>예시 가격</span>
              <p>
                마지막 확인 ·{" "}
                {new Intl.DateTimeFormat("ko-KR", {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: "Asia/Seoul",
                  hour12: false,
                }).format(new Date(metadata.checkedAt))}
              </p>
            </div>
          ) : (
            <div className={`metadata-status ${metadata.phase}`}>
              {metadata.phase === "collecting" ? (
                <>
                  <LoaderCircle size={20} />
                  <div>
                    <strong>정보 수집 중</strong>
                    <p>
                      링크를 먼저 담아두었어요. 아래에서 예시 결과를 선택해
                      보세요.
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <CircleAlert size={20} />
                  <div>
                    <strong>상품 정보를 가져오지 못했어요</strong>
                    <p>원본 링크는 그대로 있어요. 이름을 직접 적어도 좋아요.</p>
                  </div>
                </>
              )}
            </div>
          )}
          {metadata.phase === "collecting" && (
            <div className="demo-controls">
              <span>수집 결과 체험</span>
              <button
                className="text-button"
                onClick={() =>
                  send({
                    type: "metadata.resolve-demo",
                    id: product.id,
                    attempt: metadata.attempt,
                    outcome: "success",
                    at: new Date().toISOString(),
                  })
                }
              >
                성공 결과 보기
              </button>
              <button
                className="text-button"
                onClick={() =>
                  send({
                    type: "metadata.resolve-demo",
                    id: product.id,
                    attempt: metadata.attempt,
                    outcome: "failure",
                    at: new Date().toISOString(),
                  })
                }
              >
                실패 결과 보기
              </button>
            </div>
          )}
          {metadata.phase === "failed" && (
            <button
              className="text-button retry-button"
              onClick={() => send({ type: "metadata.retry", id: product.id })}
            >
              <RotateCcw size={15} />
              수집 다시 시도 · 예시
            </button>
          )}
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              send({
                type: "product.edit",
                id: product.id,
                title,
                note,
                collectionIds,
              });
            }}
          >
            <label className="field">
              <span>상품 이름</span>
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                maxLength={120}
              />
            </label>
            <label className="field">
              <span>메모</span>
              <textarea
                rows={3}
                placeholder="마음에 든 이유, 살 때 확인할 것들…"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                maxLength={3000}
              />
            </label>
            <fieldset className="collection-options">
              <legend>컬렉션</legend>
              {session.collections.map((collection) => (
                <label key={collection.id}>
                  <input
                    type="checkbox"
                    checked={collectionIds.includes(collection.id)}
                    onChange={(event) =>
                      setCollectionIds(
                        event.target.checked
                          ? [...collectionIds, collection.id]
                          : collectionIds.filter((id) => id !== collection.id),
                      )
                    }
                  />
                  <span>{collection.name}</span>
                </label>
              ))}
            </fieldset>
            <button className="button secondary full" type="submit">
              변경사항 저장
            </button>
          </form>
          <Feedback session={session} />
          {purchased && (
            <form
              className="purchase-form"
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                send({
                  type: "purchase.details",
                  id: product.id,
                  date,
                  price: paid,
                });
              }}
            >
              <div className="section-caption">
                <span>구매 기록</span>
                <small>모두 선택 입력이에요</small>
              </div>
              <div className="purchase-inputs">
                <label className="field">
                  <span>구매일</span>
                  <input
                    type="date"
                    value={date}
                    onChange={(event) => setDate(event.target.value)}
                  />
                </label>
                <label className="field">
                  <span>
                    실구매가 <small>원</small>
                  </span>
                  <input
                    inputMode="numeric"
                    placeholder="미입력"
                    value={paid}
                    onChange={(event) => setPaid(event.target.value)}
                  />
                </label>
              </div>
              <button className="button secondary full" type="submit">
                구매 정보 저장
              </button>
            </form>
          )}
          <button
            className="button primary full purchase-button"
            onClick={() =>
              send({
                type: purchased ? "product.restore" : "product.purchase",
                id: product.id,
              })
            }
          >
            {purchased ? <RotateCcw size={17} /> : <Check size={17} />}
            {purchased ? "위시로 되돌리기" : "구매완료로 이동"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}

function ShareResult({ onClose }: { onClose: () => void }) {
  const [result, setResult] = useState<"success" | "duplicate" | "failure">(
    "success",
  );
  const content = {
    success: [
      "위시에 담았어요",
      "쇼핑은 계속하세요. 물건은 moti가 기억할게요.",
    ],
    duplicate: [
      "이미 담아둔 상품이에요",
      "같은 옵션의 상품을 찾아 중복으로 담지 않았어요.",
    ],
    failure: [
      "링크는 안전하게 담았어요",
      "상품 정보는 가져오지 못했지만, 링크는 남아 있어요.",
    ],
  }[result];
  return (
    <Dialog title="공유 저장 결과" onClose={onClose}>
      <div className="share-result">
        <div className={`result-mark ${result}`}>
          {result === "failure" ? <Link2 size={29} /> : <Check size={29} />}
        </div>
        <h3>{content[0]}</h3>
        <p>{content[1]}</p>
        <div className="share-preview">
          <Image src="/images/headphones.jpg" alt="" width={64} height={64} />
          <div>
            <strong>무선 헤드폰</strong>
            <span>SOUND ROOM · 블랙</span>
          </div>
          <Bookmark size={18} />
        </div>
      </div>
      <div className="result-switcher" aria-label="공유 결과 예시">
        {(["success", "duplicate", "failure"] as const).map((key, index) => (
          <button
            className={result === key ? "active" : ""}
            aria-pressed={result === key}
            key={key}
            onClick={() => setResult(key)}
          >
            {["저장 예시", "중복 예시", "실패 예시"][index]}
          </button>
        ))}
      </div>
      <p className="demo-disclaimer">
        실제 저장이나 단축어 연결은 하지 않는 예시 화면이에요.
      </p>
      <button className="button primary full" onClick={onClose}>
        확인
      </button>
    </Dialog>
  );
}

export function ModalContent({
  modal,
  session,
  dispatch,
}: {
  modal: Modal;
  session: Session;
  dispatch: Dispatch<AppAction>;
}) {
  const onClose = () => dispatch({ type: "close" });
  if (modal.kind === "add")
    return (
      <AddLink
        session={session}
        collectionId={modal.collectionId}
        dispatch={dispatch}
        onClose={onClose}
      />
    );
  if (modal.kind === "collection")
    return (
      <CollectionForm
        session={session}
        id={modal.id}
        dispatch={dispatch}
        onClose={onClose}
      />
    );
  if (modal.kind === "share") return <ShareResult onClose={onClose} />;
  const product = session.products.find((p) => p.id === modal.id);
  return product ? (
    <Detail
      product={product}
      session={session}
      dispatch={dispatch}
      onClose={onClose}
    />
  ) : null;
}
