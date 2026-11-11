"use client";

import { Bookmark, Folder, LogOut, Plus } from "lucide-react";
import type { LibraryReadResponse } from "../presentation/library-dto";
import { AddLinkDialog } from "./AddLinkDialog";
import { CollectionDialog } from "./CollectionDialog";
import { LibraryProductCard } from "./LibraryProductCard";
import { ProductDetailDialog } from "./ProductDetailDialog";
import { visibleProducts, type LibraryScreenState, type ScreenEvent } from "./screen-state";
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

function countIn(library: LibraryReadResponse, collectionId: string | null) {
  if (collectionId === null) return library.products.length;
  return library.products.filter((product) => product.collectionIds.includes(collectionId)).length;
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
      <CollectionDialog name={dialog.name} saving={dialog.saving} refreshing={state.refreshing} error={dialog.error} send={send} />
    );
  }
  if (dialog?.kind === "detail") {
    const product = library.products.find((item) => item.id === dialog.productId);
    return product ? (
      <ProductDetailDialog
        key={product.id}
        product={product}
        collections={library.collections}
        arrival={dialog.arrival}
        onClose={() => send({ type: "dialog.close" })}
      />
    ) : null;
  }
  return null;
}

function ReadyScreen({ state, send }: { state: Ready; send: Send }) {
  const { library, collectionId } = state;
  const selected = library.collections.find((collection) => collection.id === collectionId) ?? null;
  const products = visibleProducts(library, collectionId);
  const filters = [{ id: null, name: "전체" }, ...library.collections];
  const filter = (id: string | null) => send({ type: "filter", collectionId: id });
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand size={24} onClick={() => filter(null)} />
        <p className="workspace-label">나만의 취향 보관함</p>
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
              className={item.id === collectionId ? "collection-nav active" : "collection-nav"}
              aria-current={item.id === collectionId ? "page" : undefined}
              onClick={() => filter(item.id)}
            >
              {item.id === null ? <Bookmark size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}
              <span>{item.name}</span>
              <small className="collection-count">{countIn(library, item.id)}</small>
            </button>
          ))}
        </nav>
        <SignOut />
      </aside>
      <div className="mobile-top">
        <Brand size={21} onClick={() => filter(null)} />
        <SignOut />
      </div>
      <main className="main-content" id="main-content">
        <header className="page-heading">
          <div>
            <h1>{selected ? selected.name : "나의 위시리스트"}</h1>
            <p>{selected ? "같은 마음으로 모아둔 물건들" : "지금은 담아두고, 마음이 정해지면 꺼내보세요."}</p>
          </div>
          <div className="header-actions">
            <button className="button primary add-button" data-focus-fallback onClick={() => send({ type: "add.open" })}>
              <Plus size={18} />
              링크 추가
            </button>
          </div>
        </header>
        <div className="category-row collection-chips" role="group" aria-label="컬렉션 필터">
          {filters.map((item) => (
            <button
              key={item.id ?? "all"}
              className={item.id === collectionId ? "active" : ""}
              aria-pressed={item.id === collectionId}
              onClick={() => filter(item.id)}
            >
              {item.name} <span>{countIn(library, item.id)}</span>
            </button>
          ))}
          <button aria-label="컬렉션 만들기" onClick={() => send({ type: "collection.open" })}>
            <Plus size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="results-heading">
          <p>
            담아둔 물건 <strong>{products.length}</strong>
          </p>
          <span>천천히 골라도 괜찮아요</span>
        </div>
        {products.length > 0 ? (
          <div className="product-grid">
            {products.map((product) => (
              <LibraryProductCard
                key={product.id}
                product={product}
                collections={library.collections}
                onOpen={() => send({ type: "detail.open", productId: product.id })}
              />
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-mark">
              <Bookmark size={29} aria-hidden="true" />
            </div>
            <h2>아직 담아둔 물건이 없어요</h2>
            <p>마음에 드는 물건을 발견하면 이곳에 담아두세요.</p>
            <button className="button secondary" onClick={() => send({ type: "add.open" })}>
              첫 물건 담기
            </button>
          </div>
        )}
        <footer className="page-footer">
          <span>moti</span>
          <p>좋아하는 것들을, 잊지 않도록.</p>
          <span>나만의 취향 보관함</span>
        </footer>
      </main>
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
