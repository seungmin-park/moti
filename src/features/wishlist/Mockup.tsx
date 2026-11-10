"use client";

import Image from "next/image";
import { useReducer, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronRight,
  Folder,
  Grid2X2,
  Link2,
  Pencil,
  Plus,
  Search,
  Share2,
  ShoppingBag,
  Smartphone,
  X,
} from "lucide-react";
import {
  categories,
  createDemoSession,
  reduceSession,
  selectProducts,
  type Category,
  type ProductQuery,
  type Session,
} from "./model";
import { ModalContent, type AppAction, type Modal } from "./Dialogs";
import { ProductCard } from "./ProductCard";

type View = "wish" | "purchased" | "collections" | "share";
type AppState = { session: Session; modal: Modal | null };
const navigation = [
  { id: "wish", label: "위시리스트", icon: Bookmark },
  { id: "purchased", label: "구매완료", icon: ShoppingBag },
  { id: "collections", label: "컬렉션", icon: Grid2X2 },
  { id: "share", label: "공유 저장", icon: Share2 },
] as const;

function appReducer(state: AppState, action: AppAction): AppState {
  if (action.type === "open")
    return {
      session: reduceSession(state.session, { type: "feedback.dismiss" }),
      modal: action.modal,
    };
  if (action.type === "close")
    return {
      session: reduceSession(state.session, { type: "feedback.dismiss" }),
      modal: null,
    };
  const session = reduceSession(state.session, action.command);
  let modal = state.modal;
  if (
    session.feedback?.kind === "added" ||
    session.feedback?.kind === "duplicate"
  )
    modal = { kind: "detail", id: session.feedback.productId };
  if (
    session.feedback?.kind !== "invalid" &&
    [
      "product.purchase",
      "product.restore",
      "collection.create",
      "collection.rename",
    ].includes(action.command.type)
  )
    modal = null;
  return { session, modal };
}

function Nav({
  active,
  onChange,
  mobile = false,
}: {
  active: View;
  onChange: (view: View) => void;
  mobile?: boolean;
}) {
  return (
    <nav
      className={mobile ? "mobile-nav" : "desktop-nav"}
      aria-label={mobile ? "모바일 메뉴" : "주요 메뉴"}
    >
      {navigation.map(({ id, label, icon: Icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={active === id ? "active" : ""}
          aria-current={active === id ? "page" : undefined}
        >
          <Icon size={19} strokeWidth={1.7} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

export default function Mockup() {
  const [{ session, modal }, dispatch] = useReducer(
    appReducer,
    undefined,
    () => ({ session: createDemoSession(), modal: null }),
  );
  const [view, setView] = useState<View>("wish");
  const [collectionId, setCollectionId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category | "all">("all");
  const [sort, setSort] = useState<ProductQuery["sort"]>("newest");
  const selectedCollection = session.collections.find(
    (c) => c.id === collectionId,
  );
  const isCollectionDetail =
    view === "collections" && Boolean(selectedCollection);
  const status = isCollectionDetail
    ? "all"
    : view === "purchased"
      ? "purchased"
      : "wish";
  const products = selectProducts(session, {
    status,
    query,
    category,
    collectionId: isCollectionDetail ? collectionId : null,
    sort,
  });
  const scopeProducts = selectProducts(session, {
    status,
    query: "",
    category: "all",
    collectionId: isCollectionDetail ? collectionId : null,
    sort: "newest",
  });
  const showList =
    view === "wish" || view === "purchased" || isCollectionDetail;
  const undoToken =
    session.feedback?.kind === "purchased" &&
    session.feedback.undoToken === session.undo?.token
      ? session.feedback.undoToken
      : null;
  const resetFilters = () => {
    setQuery("");
    setCategory("all");
    setSort("newest");
  };
  const navigate = (next: View) => {
    setView(next);
    setCollectionId(null);
    resetFilters();
    dispatch({ type: "close" });
  };
  const openCollection = (id: string) => {
    setView("collections");
    setCollectionId(id);
    resetFilters();
    dispatch({ type: "close" });
  };
  const openAdd = () =>
    dispatch({
      type: "open",
      modal: {
        kind: "add",
        collectionId: isCollectionDetail
          ? (collectionId ?? undefined)
          : undefined,
      },
    });
  const title =
    selectedCollection && isCollectionDetail
      ? selectedCollection.name
      : view === "purchased"
        ? "함께하게 된 물건들"
        : view === "collections"
          ? "나의 컬렉션"
          : view === "share"
            ? "공유 저장"
            : "나의 위시리스트";
  const subtitle = isCollectionDetail
    ? "같은 마음으로 모아둔 물건들"
    : view === "purchased"
      ? "고민 끝에 내 일상으로 들어온 것들"
      : view === "collections"
        ? "취향에도 나름의 자리가 있으니까"
        : view === "share"
          ? "발견한 순간, 잊기 전에 담아두세요"
          : "지금은 담아두고, 마음이 정해지면 꺼내보세요.";
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="brand"
          aria-label="moti 위시리스트로"
          onClick={() => navigate("wish")}
        >
          <span className="brand-mark">
            <Bookmark size={24} strokeWidth={2.1} />
          </span>
          moti<span className="brand-dot">.</span>
        </button>
        <p className="workspace-label">나만의 취향 보관함</p>
        <Nav active={view} onChange={navigate} />
        <div className="sidebar-collections">
          <div className="sidebar-section-heading">
            <span>내 컬렉션</span>
            <button
              className="icon-button"
              aria-label="컬렉션 만들기"
              onClick={() => {
                navigate("collections");
                dispatch({ type: "open", modal: { kind: "collection" } });
              }}
            >
              <Plus size={16} />
            </button>
          </div>
          {session.collections.map((collection) => (
            <button
              key={collection.id}
              className={
                isCollectionDetail && collectionId === collection.id
                  ? "collection-nav active"
                  : "collection-nav"
              }
              onClick={() => openCollection(collection.id)}
            >
              <Folder size={16} />
              <span>{collection.name}</span>
              <ChevronRight size={13} />
            </button>
          ))}
        </div>
        <button className="sidebar-share" onClick={() => navigate("share")}>
          <Smartphone size={21} strokeWidth={1.5} />
          <strong>발견한 곳에서 바로</strong>
          <span>iPhone 공유 저장 알아보기</span>
          <ArrowUpRight size={17} />
        </button>
        <div className="sidebar-bottom">
          <span className="preview-dot" />
          <span>목업 둘러보기</span>
          <span>v0.1</span>
        </div>
      </aside>
      <div className="mobile-top">
        <button
          className="brand"
          aria-label="moti 위시리스트로"
          onClick={() => navigate("wish")}
        >
          <span className="brand-mark">
            <Bookmark size={21} />
          </span>
          moti<span className="brand-dot">.</span>
        </button>
        <span className="preview-label">미리보기</span>
      </div>
      <main className="main-content" id="main-content">
        <div className="demo-notice">
          <span className="preview-dot" />
          <p>
            예시 데이터 <span>· 새로고침하면 처음으로 돌아가요.</span>
          </p>
          <span className="notice-end">클릭하며 둘러보세요</span>
        </div>
        {isCollectionDetail && (
          <button
            className="back-button"
            onClick={() => navigate("collections")}
          >
            <ArrowLeft size={15} />
            모든 컬렉션
          </button>
        )}
        <header className="page-heading">
          <div>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <div className="header-actions">
            {isCollectionDetail && (
              <button
                className="icon-button"
                aria-label="컬렉션 이름 변경"
                onClick={() =>
                  dispatch({
                    type: "open",
                    modal: {
                      kind: "collection",
                      id: collectionId ?? undefined,
                    },
                  })
                }
              >
                <Pencil size={17} />
              </button>
            )}
            {showList && (
              <button
                className="button primary add-button"
                onClick={openAdd}
                data-focus-fallback
              >
                <Plus size={18} />
                링크 추가
              </button>
            )}
            {view === "collections" && !isCollectionDetail && (
              <button
                className="button primary"
                onClick={() =>
                  dispatch({ type: "open", modal: { kind: "collection" } })
                }
              >
                <Plus size={18} />새 컬렉션
              </button>
            )}
          </div>
        </header>
        {showList && (
          <>
            <div className="list-toolbar">
              <div className="search-field">
                <Search size={18} strokeWidth={1.7} />
                <input
                  type="search"
                  aria-label="상품 검색"
                  placeholder="어떤 물건을 찾고 있나요?"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {query && (
                  <button
                    className="icon-button"
                    aria-label="검색어 지우기"
                    onClick={() => setQuery("")}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
              <label className="sort-field">
                <span className="sr-only">정렬</span>
                <select
                  aria-label="정렬"
                  value={sort}
                  onChange={(event) =>
                    setSort(event.target.value as ProductQuery["sort"])
                  }
                >
                  <option value="newest">최근 담은 순</option>
                  <option value="price-low">낮은 가격순</option>
                  <option value="price-high">높은 가격순</option>
                </select>
              </label>
            </div>
            <div className="category-row" aria-label="상품 카테고리">
              <button
                className={category === "all" ? "active" : ""}
                aria-pressed={category === "all"}
                onClick={() => setCategory("all")}
              >
                전체 <span>{scopeProducts.length}</span>
              </button>
              {categories
                .filter(
                  (value) =>
                    value !== "기타" ||
                    scopeProducts.some((p) => p.category === "기타"),
                )
                .map((value) => (
                  <button
                    key={value}
                    className={category === value ? "active" : ""}
                    aria-pressed={category === value}
                    onClick={() => setCategory(value)}
                  >
                    {value}
                  </button>
                ))}
            </div>
            <div className="results-heading">
              <p>
                {isCollectionDetail
                  ? "함께 담은 물건"
                  : view === "purchased"
                    ? "구매한 물건"
                    : "담아둔 물건"}{" "}
                <strong>{products.length}</strong>
              </p>
              <span>
                {view === "purchased"
                  ? "구매일과 실구매가는 나중에 적어도 돼요"
                  : "천천히 골라도 괜찮아요"}
              </span>
            </div>
            {products.length > 0 ? (
              <div className="product-grid">
                {products.map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    collections={session.collections}
                    onOpen={() =>
                      dispatch({
                        type: "open",
                        modal: { kind: "detail", id: product.id },
                      })
                    }
                    onPurchase={() =>
                      dispatch({
                        type: "domain",
                        command: { type: "product.purchase", id: product.id },
                      })
                    }
                  />
                ))}
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-mark">
                  {query || category !== "all" ? (
                    <Search size={28} />
                  ) : (
                    <Bookmark size={29} />
                  )}
                </div>
                <h2>
                  {query || category !== "all"
                    ? "찾는 물건이 없어요"
                    : view === "purchased"
                      ? "아직 구매한 물건이 없어요"
                      : "아직 담아둔 물건이 없어요"}
                </h2>
                <p>
                  {query || category !== "all"
                    ? "다른 검색어나 카테고리로 찾아보세요."
                    : "마음에 드는 물건을 발견하면 이곳에 담아두세요."}
                </p>
                <button
                  className="button secondary"
                  onClick={query || category !== "all" ? resetFilters : openAdd}
                >
                  {query || category !== "all"
                    ? "검색·필터 초기화"
                    : "첫 물건 담기"}
                </button>
              </div>
            )}
            <p className="list-footnote">
              가격과 상품 정보는 예시예요. 실제 가격은 원본 쇼핑몰에서 확인해
              주세요.
            </p>
          </>
        )}
        {view === "collections" && !isCollectionDetail && (
          <div className="collection-grid">
            {session.collections.map((collection) => {
              const items = session.products.filter((p) =>
                p.collectionIds.includes(collection.id),
              );
              return (
                <button
                  key={collection.id}
                  className="collection-card"
                  aria-label={`${collection.name} 컬렉션 열기`}
                  onClick={() => openCollection(collection.id)}
                >
                  <div
                    className={`collection-cover ${items.length === 0 ? "empty-cover" : ""}`}
                  >
                    {items.length === 0 ? (
                      <Folder size={38} strokeWidth={1.2} />
                    ) : (
                      items.slice(0, 3).map((product) =>
                        product.image ? (
                          <Image
                            key={product.id}
                            src={product.image}
                            alt=""
                            width={400}
                            height={400}
                            sizes="200px"
                          />
                        ) : (
                          <span key={product.id}>
                            <Link2 size={28} />
                          </span>
                        ),
                      )
                    )}
                  </div>
                  <div className="collection-card-copy">
                    <div>
                      <h2>{collection.name}</h2>
                      <p>담아둔 물건 {items.length}개</p>
                    </div>
                    <ArrowUpRight size={20} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
        {view === "share" && (
          <section className="share-page">
            <div className="share-explanation">
              <span className="section-eyebrow">
                <Smartphone size={17} />
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
                  <span>1</span>
                  <div>
                    <h3>처음 한 번, 단축어 연결</h3>
                    <p>
                      실제 서비스에서는 로그인 후 나만의 저장 키로 연결해요. 이
                      목업에서는 연결하지 않아요.
                    </p>
                  </div>
                </li>
                <li>
                  <span>2</span>
                  <div>
                    <h3>마음에 드는 상품에서 공유</h3>
                    <p>
                      Safari나 쇼핑 앱의 공유 메뉴에서 moti 단축어를 선택해요.
                    </p>
                  </div>
                </li>
                <li>
                  <span>3</span>
                  <div>
                    <h3>담았다는 메시지만 확인</h3>
                    <p>
                      정보를 가져오지 못해도 링크는 남겨두고, 나중에 정리하면
                      돼요.
                    </p>
                  </div>
                </li>
              </ol>
              <button
                className="button primary"
                onClick={() =>
                  dispatch({ type: "open", modal: { kind: "share" } })
                }
              >
                공유 저장 체험하기 <ArrowRight size={17} />
              </button>
              <p className="small-muted setup-note">
                실제 단축어 설치는 화면 확정 후 제공할 예정이에요.
              </p>
            </div>
            <div className="phone-preview" aria-label="공유 저장 예시">
              <div className="phone-camera" />
              <div className="phone-product">
                <Image
                  src="/images/headphones.jpg"
                  alt="무선 헤드폰 예시"
                  width={350}
                  height={350}
                />
                <span>SOUND ROOM</span>
                <h3>무선 헤드폰</h3>
                <p>289,000원</p>
              </div>
              <div className="phone-sheet">
                <div className="sheet-handle" />
                <div className="phone-app">
                  <span className="brand-mark">
                    <Bookmark size={20} />
                  </span>
                  <div>
                    <strong>moti에 담기</strong>
                    <span>발견한 순간을 기억해요</span>
                  </div>
                  <ChevronRight size={17} />
                </div>
                <div className="phone-success">
                  <Check size={17} />
                  위시에 담았어요<span>예시</span>
                </div>
              </div>
            </div>
          </section>
        )}
        <footer className="page-footer">
          <span>moti</span>
          <p>좋아하는 것들을, 잊지 않도록.</p>
          <span>나만의 취향 보관함</span>
        </footer>
      </main>
      <Nav active={view} onChange={navigate} mobile />
      {!modal &&
        (session.feedback?.kind === "changed" ||
          session.feedback?.kind === "purchased") && (
          <div className="toast" role="status">
            <Check size={17} />
            <span>{session.feedback.message}</span>
            {undoToken !== null && (
              <button
                onClick={() =>
                  dispatch({
                    type: "domain",
                    command: {
                      type: "purchase.undo",
                      token: undoToken,
                    },
                  })
                }
              >
                실행 취소
              </button>
            )}
            <button
              className="toast-close"
              aria-label="알림 닫기"
              onClick={() =>
                dispatch({
                  type: "domain",
                  command: { type: "feedback.dismiss" },
                })
              }
            >
              <X size={16} />
            </button>
          </div>
        )}
      {modal && (
        <ModalContent
          key={`${modal.kind}-${"id" in modal ? modal.id : ""}`}
          modal={modal}
          session={session}
          dispatch={dispatch}
        />
      )}
    </div>
  );
}
