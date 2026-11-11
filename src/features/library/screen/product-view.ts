import type { CollectionResponse, ProductResponse } from "../presentation/library-dto";

export type PriceView = { value: string; checked: string | null };
export type CollectionLabel = { filed: boolean; text: string };
export type ProductCardView = {
  shop: string;
  title: string;
  option: string;
  status: string | null;
  purchased: boolean;
  price: PriceView;
  collection: CollectionLabel;
};
export type ProductDetailView = {
  shop: string;
  title: string;
  option: string;
  purchased: boolean;
  price: PriceView;
  status: { title: string; detail: string };
  sourceUrl: string;
  openUrl: string | null;
  collectionNames: string[];
  addedOn: string;
  note: string | null;
  arrival: string | null;
};

const seoulDate = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Seoul" });
const onSeoulDate = (timestamp: string) => seoulDate.format(new Date(timestamp));

const waiting = "상품 정보는 아직 가져오지 않았어요. 원본 링크는 보관했어요.";
const statusChip: Record<ProductResponse["metadata"]["phase"], string | null> = {
  queued: "정보 수집 대기",
  running: "정보 수집 중",
  failed: "정보를 가져오지 못했어요",
  ready: null,
};
const arrivals = { added: "위시에 담았어요", duplicate: "이미 담아둔 상품이에요" } as const;

function priceOf(product: ProductResponse): PriceView {
  const price = product.lastSuccessfulPrice;
  if (!price) return { value: "가격 확인 전", checked: null };
  const format = new Intl.NumberFormat("ko-KR", { style: "currency", currency: price.currency });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 0;
  return { value: format.format(price.amountMinor / 10 ** digits), checked: `마지막 확인 ${onSeoulDate(price.checkedAt)}` };
}

function namesOf(product: ProductResponse, collections: CollectionResponse[]): string[] {
  const names = new Map(collections.map((collection) => [collection.id, collection.name]));
  return product.collectionIds.flatMap((id) => names.get(id) ?? []);
}

function statusOf(metadata: ProductResponse["metadata"]): ProductDetailView["status"] {
  switch (metadata.phase) {
    case "queued":
      return { title: "정보 수집 대기", detail: waiting };
    case "running":
      return { title: "정보 수집 중", detail: waiting };
    case "failed":
      return { title: "정보를 가져오지 못했어요", detail: "원본 링크는 그대로 보관했어요." };
    case "ready":
      return { title: "상품 정보를 가져왔어요", detail: `${onSeoulDate(metadata.completedAt)}에 확인했어요.` };
  }
}

function openableUrl(value: string): string | null {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}

export function toProductCardView(product: ProductResponse, collections: CollectionResponse[]): ProductCardView {
  const [first, ...rest] = namesOf(product, collections);
  return {
    shop: product.shop,
    title: product.title,
    option: product.option || "옵션 미입력",
    status: statusChip[product.metadata.phase],
    purchased: product.purchase.status === "purchased",
    price: priceOf(product),
    collection: first === undefined
      ? { filed: false, text: "아직 분류하지 않았어요" }
      : { filed: true, text: rest.length > 0 ? `${first} +${rest.length}` : first },
  };
}

export function toProductDetailView(
  product: ProductResponse,
  collections: CollectionResponse[],
  arrival: "added" | "duplicate" | null,
): ProductDetailView {
  return {
    shop: product.shop,
    title: product.title,
    option: product.option || "옵션 미입력",
    purchased: product.purchase.status === "purchased",
    price: priceOf(product),
    status: statusOf(product.metadata),
    sourceUrl: product.sourceUrl,
    openUrl: openableUrl(product.sourceUrl),
    collectionNames: namesOf(product, collections),
    addedOn: onSeoulDate(product.addedAt),
    note: product.note.trim() ? product.note : null,
    arrival: arrival && arrivals[arrival],
  };
}
