"use client";

import { Archive, Bookmark, CalendarClock, Check, Folder, LogOut, Pencil, Plus, Share2, ShoppingBag, X } from "lucide-react";
import type { LibraryReadResponse } from "../presentation/library-dto";
import { AddLinkDialog } from "./AddLinkDialog";
import { BackupDialog } from "./BackupDialog";
import { CollectionDialog } from "./CollectionDialog";
import { LibraryProductCard } from "./LibraryProductCard";
import { ProductDetailDialog } from "./ProductDetailDialog";
import { ShareView } from "./ShareView";
import { WorkerDialog } from "./WorkerDialog";
import { visibleProducts, visibleToast, type LibraryScreenState, type ScreenEvent, type View } from "./screen-state";
import { useLibraryScreen } from "./useLibraryScreen";

type Ready = Extract<LibraryScreenState, { phase: "ready" }>;
type Send = (event: ScreenEvent) => void;

function Brand({ size, onClick }: { size: number; onClick: () => void }) {
  return (
    <button className="brand" aria-label="moti 전체 보관함으로" onClick={onClick}>
      <span className="brand-mark">
        <Bookmark size={size} strokeWidth={2.1} />
      </span>
      moti<span className="brand-dot">.</span>
    </button>
  );
}

function SignOut() {
  return (
    <form className="sign-out" method="post" action="/auth/logout">
      <button className="text-button" type="submit">
        <LogOut size={15} aria-hidden="true" />
        로그아웃
      </button>
    </form>
  );
}

const views = [
  { id: "wish", label: "위시리스트", icon: Bookmark },
  { id: "purchased", label: "구매완료", icon: ShoppingBag },
  { id: "share", label: "공유 저장", icon: Share2 },
] as const;

type ListView = Exclude<View, "share">;

const headings: Record<View, { title: string; lead: string }> = {
  wish: { title: "나의 위시리스트", lead: "지금은 담아두고, 마음이 정해지면 꺼내보세요." },
  purchased: { title: "함께하게 된 물건들", lead: "고민 끝에 내 일상으로 들어온 것들" },
  share: { title: "공유 저장", lead: "발견한 순간, 잊기 전에 담아두세요" },
};

const lists: Record<ListView, { results: string; hint: string }> = {
  wish: { results: "담아둔 물건", hint: "천천히 골라도 괜찮아요" },
  purchased: { results: "구매한 물건", hint: "구매일과 실구매가는 나중에 적어도 돼요" },
};

function countIn(library: LibraryReadResponse, view: ListView, collectionId: string | null) {
  return visibleProducts(library, view, collectionId).length;
}

function ViewNav({ view, send, mobile = false }: { view: View; send: Send; mobile?: boolean }) {
  return (
    <nav className={mobile ? "mobile-nav" : "desktop-nav"} aria-label={mobile ? "모바일 보기" : "보기"}>
      {views.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          className={view === id ? "active" : ""}
          aria-current={view === id ? "page" : undefined}
          onClick={() => send({ type: "view", view: id })}
        >
          <Icon size={19} strokeWidth={1.7} aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

// The region stays mounted so screen readers announce a toast when it appears.
function Toast({ state, send }: { state: Ready; send: Send }) {
  const toast = visibleToast(state);
  return (
    <div role="status">
      {toast && (
        <div className="toast">
          <Check size={17} aria-hidden="true" />
          <span>{toast.message}</span>
          {toast.undo && (
            <button disabled={state.writing !== null || state.refreshing} onClick={() => send({ type: "toast.undo" })}>
              실행 취소
            </button>
          )}
          <button className="toast-close" aria-label="알림 닫기" onClick={() => send({ type: "toast.dismiss" })}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}

function ScreenDialogs({ state, send }: { state: Ready; send: Send }) {
  const { dialog, library } = state;
  if (dialog?.kind === "add") {
    return (
      <AddLinkDialog
        draft={dialog.draft}
        saving={dialog.saving}
        creating={dialog.creating}
        refreshing={state.refreshing}
        error={dialog.error}
        collections={library.collections}
        send={send}
      />
    );
  }
  if (dialog?.kind === "collection") {
    return (
      <CollectionDialog
        renaming={dialog.renaming !== null}
        name={dialog.name}
        saving={dialog.saving}
        refreshing={state.refreshing}
        error={dialog.error}
        send={send}
      />
    );
  }
  if (dialog?.kind === "worker") return <WorkerDialog panel={state.worker.panel} runs={state.worker.runs} send={send} />;
  if (dialog?.kind === "backup") {
    return <BackupDialog step={dialog.step} notice={dialog.notice} blocked={state.writing !== null || state.refreshing} send={send} />;
  }
  if (dialog?.kind === "detail") {
    const product = library.products.find((item) => item.id === dialog.productId);
    return product ? (
      <ProductDetailDialog
        key={product.id}
        product={product}
        collections={library.collections}
        arrival={dialog.arrival}
        draft={dialog.draft}
        notice={dialog.notice}
        confirming={dialog.confirming === true}
        writing={state.writing?.productId === product.id ? state.writing.intent : null}
        blocked={state.writing !== null || state.refreshing}
        send={send}
      />
    ) : null;
  }
  return null;
}

function ProductList({ state, view, send }: { state: Ready; view: ListView; send: Send }) {
  const { library, collectionId } = state;
  const products = visibleProducts(library, view, collectionId);
  const writable = state.writing === null && !state.refreshing;
  const filters = [{ id: null, name: "전체" }, ...library.collections];
  return (
    <>
      <div className="category-row collection-chips" role="group" aria-label="컬렉션 필터">
        {filters.map((item) => (
          <button
            key={item.id ?? "all"}
            className={item.id === collectionId ? "active" : ""}
            aria-pressed={item.id === collectionId}
            onClick={() => send({ type: "filter", collectionId: item.id })}
          >
            {item.name} <span>{countIn(library, view, item.id)}</span>
          </button>
        ))}
        <button aria-label="컬렉션 만들기" onClick={() => send({ type: "collection.open" })}>
          <Plus size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="results-heading">
        <p>
          {lists[view].results} <strong>{products.length}</strong>
        </p>
        <span>{lists[view].hint}</span>
      </div>
      {products.length > 0 ? (
        <div className="product-grid">
          {products.map((product) => (
            <LibraryProductCard
              key={product.id}
              product={product}
              collections={library.collections}
              purchasing={!writable}
              onOpen={() => send({ type: "detail.open", productId: product.id })}
              onPurchase={() => send({ type: "product.purchase", productId: product.id })}
            />
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <div className="empty-mark">
            <Bookmark size={29} aria-hidden="true" />
          </div>
          {view === "wish" ? (
            <>
              <h2>아직 담아둔 물건이 없어요</h2>
              <p>마음에 드는 물건을 발견하면 이곳에 담아두세요.</p>
              <button className="button secondary" onClick={() => send({ type: "add.open" })}>
                첫 물건 담기
              </button>
            </>
          ) : (
            <>
              <h2>아직 구매한 물건이 없어요</h2>
              <p>구매완료로 옮긴 물건이 이곳에 모여요.</p>
            </>
          )}
        </div>
      )}
    </>
  );
}

function ReadyScreen({ state, send }: { state: Ready; send: Send }) {
  const { library, collectionId, view } = state;
  // The share view lists no products: the sidebar counts and the collection it shows are the wish list's.
  const listView: ListView | null = view === "share" ? null : view;
  const selected = listView === null ? null : library.collections.find((collection) => collection.id === collectionId) ?? null;
  const heading = headings[view];
  const filters = [{ id: null, name: "전체" }, ...library.collections];
  const filter = (id: string | null) => send({ type: "filter", collectionId: id });
  const current = (id: string | null) => listView !== null && id === collectionId;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand size={24} onClick={() => filter(null)} />
        <p className="workspace-label">나만의 취향 보관함</p>
        <ViewNav view={view} send={send} />
        <nav className="sidebar-collections" aria-label="컬렉션">
          <div className="sidebar-section-heading">
            <span>내 컬렉션</span>
            <button className="icon-button" aria-label="컬렉션 만들기" onClick={() => send({ type: "collection.open" })}>
              <Plus size={16} />
            </button>
          </div>
          {filters.map((item) => (
            <button
              key={item.id ?? "all"}
              className={current(item.id) ? "collection-nav active" : "collection-nav"}
              aria-current={current(item.id) ? "page" : undefined}
              onClick={() => filter(item.id)}
            >
              {item.id === null ? <Bookmark size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}
              <span>{item.name}</span>
              <small className="collection-count">{countIn(library, listView ?? "wish", item.id)}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <button className="text-button" onClick={() => send({ type: "backup.open" })}>
            <Archive size={15} aria-hidden="true" />
            백업과 복원
          </button>
          <button className="text-button" onClick={() => send({ type: "worker.open" })}>
            <CalendarClock size={15} aria-hidden="true" />
            자동 확인
          </button>
          <SignOut />
        </div>
      </aside>
      <div className="mobile-top">
        <Brand size={21} onClick={() => filter(null)} />
        <div className="mobile-actions">
          <button className="icon-button" aria-label="백업과 복원" title="백업과 복원" onClick={() => send({ type: "backup.open" })}>
            <Archive size={19} aria-hidden="true" />
          </button>
          <button className="icon-button" aria-label="자동 확인" title="자동 확인" onClick={() => send({ type: "worker.open" })}>
            <CalendarClock size={19} aria-hidden="true" />
          </button>
          <SignOut />
        </div>
      </div>
      <main className="main-content" id="main-content">
        <header className="page-heading">
          <div>
            <h1>{selected ? selected.name : heading.title}</h1>
            <p>{selected ? "같은 마음으로 모아둔 물건들" : heading.lead}</p>
          </div>
          <div className="header-actions">
            {selected && (
              <button
                className="icon-button"
                aria-label="컬렉션 이름 바꾸기"
                title="컬렉션 이름 바꾸기"
                onClick={() => send({ type: "rename.open", collectionId: selected.id })}
              >
                <Pencil size={17} aria-hidden="true" />
              </button>
            )}
            {listView !== null && (
              <button className="button primary add-button" data-focus-fallback onClick={() => send({ type: "add.open" })}>
                <Plus size={18} />
                링크 추가
              </button>
            )}
          </div>
        </header>
        {listView === null ? <ShareView panel={state.share} send={send} /> : <ProductList state={state} view={listView} send={send} />}
        <footer className="page-footer">
          <span>moti</span>
          <p>좋아하는 것들을, 잊지 않도록.</p>
          <span>나만의 취향 보관함</span>
        </footer>
      </main>
      <ViewNav view={view} send={send} mobile />
      <Toast state={state} send={send} />
      <ScreenDialogs state={state} send={send} />
    </div>
  );
}

export function LibraryScreen() {
  const { state, send } = useLibraryScreen();
  if (state.phase === "ready") return <ReadyScreen state={state} send={send} />;
  return (
    <main className="screen-status">
      {state.phase === "failed" ? (
        <>
          <p className="form-error" role="alert">
            {state.message}
          </p>
          <button className="button secondary" onClick={() => send({ type: "retry" })}>
            다시 불러오기
          </button>
        </>
      ) : (
        <p role="status">{state.phase === "leaving" ? "로그인 화면으로 이동하고 있어요" : "보관함을 불러오는 중이에요"}</p>
      )}
    </main>
  );
}
