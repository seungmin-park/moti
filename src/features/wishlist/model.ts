import { demoCollections, demoProducts } from "./demo-data";

export const categories = ["디지털", "리빙", "패션", "취미", "기타"] as const;
export type Category = (typeof categories)[number];
export type Purchase =
  | { status: "wish" }
  | { status: "purchased"; date: string | null; price: number | null };
export type Metadata =
  | { phase: "collecting"; attempt: number }
  | { phase: "ready"; attempt: number; checkedAt: string; price: number | null }
  | { phase: "failed"; attempt: number };
export type Product = {
  id: string;
  sourceUrl: string;
  identityUrl: string;
  option: string;
  title: string;
  shop: string;
  image: string | null;
  category: Category;
  note: string;
  collectionIds: string[];
  addedAt: string;
  metadata: Metadata;
  purchase: Purchase;
};
export type Collection = { id: string; name: string };
export type Feedback =
  | { kind: "added" | "duplicate"; productId: string }
  | { kind: "collection-created"; collectionId: string }
  | { kind: "changed"; message: string }
  | { kind: "purchased"; message: string; undoToken: number }
  | { kind: "invalid"; field: string; message: string };
export type Session = {
  products: Product[];
  collections: Collection[];
  nextId: number;
  revision: number;
  feedback: Feedback | null;
  undo: { token: number; productId: string; previous: Purchase } | null;
};
export type Command =
  | {
      type: "link.add";
      url: string;
      option: string;
      at: string;
      collectionIds: string[];
    }
  | { type: "metadata.retry"; id: string }
  | {
      type: "metadata.resolve-demo";
      id: string;
      attempt: number;
      outcome: "success" | "failure";
      at: string;
    }
  | {
      type: "product.edit";
      id: string;
      title: string;
      note: string;
      collectionIds: string[];
    }
  | { type: "product.purchase"; id: string }
  | { type: "purchase.details"; id: string; date: string; price: string }
  | { type: "purchase.undo"; token: number }
  | { type: "product.restore"; id: string }
  | { type: "collection.create"; name: string }
  | { type: "collection.rename"; id: string; name: string }
  | { type: "feedback.dismiss" };
export type ProductQuery = {
  status: "wish" | "purchased" | "all";
  query: string;
  category: Category | "all";
  collectionId: string | null;
  sort: "newest" | "price-low" | "price-high";
};

export function createDemoSession(): Session {
  return {
    products: structuredClone(demoProducts),
    collections: structuredClone(demoCollections),
    nextId: 20,
    revision: 0,
    feedback: null,
    undo: null,
  };
}

export function reduceSession(session: Session, command: Command): Session {
  if (command.type === "feedback.dismiss")
    return { ...session, feedback: null };
  if (command.type === "link.add") {
    let source: URL;
    try {
      source = new URL(command.url.trim());
    } catch {
      return invalid(
        session,
        "url",
        "http:// 또는 https://로 시작하는 상품 링크를 입력해 주세요.",
      );
    }
    if (
      !["http:", "https:"].includes(source.protocol) ||
      !source.hostname ||
      source.username ||
      source.password ||
      command.url.length > 4096
    ) {
      return invalid(
        session,
        "url",
        "로그인 정보가 없는 http:// 또는 https:// 링크를 입력해 주세요.",
      );
    }
    if (
      command.collectionIds.some(
        (id) => !session.collections.some((collection) => collection.id === id),
      )
    )
      return invalid(session, "collection", "컬렉션을 다시 선택해 주세요.");
    const identity = new URL(source);
    for (const key of [...identity.searchParams.keys()]) {
      if (
        /^utm_/i.test(key) ||
        ["gclid", "fbclid", "msclkid"].includes(key.toLowerCase())
      )
        identity.searchParams.delete(key);
    }
    identity.searchParams.sort();
    const option = command.option.trim().normalize("NFC");
    const existing = session.products.find(
      (p) => p.identityUrl === identity.href && p.option === option,
    );
    if (existing)
      return {
        ...session,
        feedback: { kind: "duplicate", productId: existing.id },
      };
    const id = `p-${session.nextId}`;
    const product: Product = {
      id,
      sourceUrl: command.url.trim(),
      identityUrl: identity.href,
      option,
      title: "새로 담은 상품",
      shop: source.hostname.replace(/^www\./, ""),
      image: null,
      category: "기타",
      note: "",
      collectionIds: [...new Set(command.collectionIds)],
      addedAt: command.at,
      metadata: { phase: "collecting", attempt: 1 },
      purchase: { status: "wish" },
    };
    return {
      ...session,
      products: [product, ...session.products],
      nextId: session.nextId + 1,
      feedback: { kind: "added", productId: id },
    };
  }
  if (
    command.type === "collection.create" ||
    command.type === "collection.rename"
  ) {
    const name = command.name.trim().normalize("NFC");
    if (!name || name.length > 40)
      return invalid(
        session,
        "collection",
        "컬렉션 이름은 1~40자로 입력해 주세요.",
      );
    const id =
      command.type === "collection.rename" ? command.id : `c-${session.nextId}`;
    if (
      session.collections.some(
        (c) =>
          c.id !== id &&
          c.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      )
    )
      return invalid(session, "collection", "같은 이름의 컬렉션이 있어요.");
    if (command.type === "collection.rename") {
      if (!session.collections.some((c) => c.id === id)) return session;
      return {
        ...session,
        collections: session.collections.map((c) =>
          c.id === id ? { ...c, name } : c,
        ),
        feedback: { kind: "changed", message: "컬렉션 이름을 바꿨어요" },
      };
    }
    return {
      ...session,
      collections: [...session.collections, { id, name }],
      nextId: session.nextId + 1,
      feedback: { kind: "collection-created", collectionId: id },
    };
  }
  if (command.type === "purchase.undo") {
    if (!session.undo || session.undo.token !== command.token) return session;
    const { productId, previous } = session.undo;
    return {
      ...session,
      products: session.products.map((p) =>
        p.id === productId ? { ...p, purchase: previous } : p,
      ),
      undo: null,
      feedback: { kind: "changed", message: "위시리스트로 되돌렸어요" },
    };
  }
  const product = session.products.find((p) => p.id === command.id);
  if (!product) return session;
  if (command.type === "metadata.retry")
    return update(session, {
      ...product,
      metadata: { phase: "collecting", attempt: product.metadata.attempt + 1 },
    });
  if (command.type === "metadata.resolve-demo") {
    if (
      product.metadata.phase !== "collecting" ||
      product.metadata.attempt !== command.attempt
    )
      return session;
    return update(session, {
      ...product,
      metadata:
        command.outcome === "failure"
          ? { phase: "failed", attempt: command.attempt }
          : {
              phase: "ready",
              attempt: command.attempt,
              checkedAt: command.at,
              price: 89000,
            },
    });
  }
  if (command.type === "product.edit") {
    const title = command.title.trim();
    if (!title || title.length > 120)
      return invalid(session, "title", "상품 이름은 1~120자로 입력해 주세요.");
    if (command.note.length > 3000)
      return invalid(session, "note", "메모는 3,000자까지 적을 수 있어요.");
    if (
      command.collectionIds.some(
        (id) => !session.collections.some((c) => c.id === id),
      )
    )
      return invalid(session, "collection", "컬렉션을 다시 선택해 주세요.");
    return update(
      session,
      {
        ...product,
        title,
        note: command.note,
        collectionIds: [...new Set(command.collectionIds)],
      },
      { kind: "changed", message: "변경사항을 저장했어요" },
    );
  }
  if (command.type === "product.purchase") {
    if (product.purchase.status === "purchased") return session;
    const revision = session.revision + 1;
    return {
      ...update(
        session,
        {
          ...product,
          purchase: { status: "purchased", date: null, price: null },
        },
        {
          kind: "purchased",
          message: "구매완료 목록으로 옮겼어요",
          undoToken: revision,
        },
      ),
      revision,
      undo: {
        token: revision,
        productId: product.id,
        previous: product.purchase,
      },
    };
  }
  if (command.type === "product.restore") {
    if (product.purchase.status === "wish") return session;
    return {
      ...update(
        session,
        { ...product, purchase: { status: "wish" } },
        { kind: "changed", message: "위시리스트로 되돌렸어요" },
      ),
      undo: session.undo?.productId === product.id ? null : session.undo,
    };
  }
  if (command.type === "purchase.details") {
    if (product.purchase.status !== "purchased") return session;
    const date = command.date.trim();
    const price = command.price.trim();
    if (
      date &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(Date.parse(date)) ||
        new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date)
    )
      return invalid(session, "date", "올바른 구매일을 입력해 주세요.");
    if (price && (!/^\d+$/.test(price) || !Number.isSafeInteger(Number(price))))
      return invalid(
        session,
        "price",
        "실구매가는 0 이상의 정수로 입력해 주세요.",
      );
    return update(
      session,
      {
        ...product,
        purchase: {
          status: "purchased",
          date: date || null,
          price: price ? Number(price) : null,
        },
      },
      { kind: "changed", message: "구매 정보를 저장했어요" },
    );
  }
  return session;
}

export function selectProducts(
  session: Session,
  query: ProductQuery,
): Product[] {
  const search = query.query.trim().toLocaleLowerCase();
  return session.products
    .filter(
      (product) =>
        (query.status === "all" || product.purchase.status === query.status) &&
        (query.category === "all" || product.category === query.category) &&
        (!query.collectionId ||
          product.collectionIds.includes(query.collectionId)) &&
        (!search ||
          [product.title, product.shop, product.option, product.note].some(
            (value) => value.toLocaleLowerCase().includes(search),
          )),
    )
    .sort((a, b) => {
      if (query.sort === "newest") return b.addedAt.localeCompare(a.addedAt);
      const aPrice = productPrice(a);
      const bPrice = productPrice(b);
      if (aPrice === null) return bPrice === null ? 0 : 1;
      if (bPrice === null) return -1;
      return query.sort === "price-low" ? aPrice - bPrice : bPrice - aPrice;
    });
}

export function productPrice(product: Product): number | null {
  if (product.purchase.status === "purchased") return product.purchase.price;
  return product.metadata.phase === "ready" ? product.metadata.price : null;
}

export function formatPrice(price: number | null): string {
  return price === null ? "가격 미확인" : `${price.toLocaleString("ko-KR")}원`;
}

function invalid(session: Session, field: string, message: string): Session {
  return { ...session, feedback: { kind: "invalid", field, message } };
}

function update(
  session: Session,
  product: Product,
  feedback: Feedback | null = null,
): Session {
  return {
    ...session,
    products: session.products.map((p) => (p.id === product.id ? product : p)),
    feedback,
  };
}
