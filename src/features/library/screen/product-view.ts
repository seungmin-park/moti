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
  canRetry: boolean;
};

const seoulDate = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Seoul" });
const onSeoulDate = (timestamp: string) => seoulDate.format(new Date(timestamp));

type Metadata = ProductResponse["metadata"];
type FailureCode = Extract<Metadata, { phase: "failed" }>["errorCode"];

const waiting = "상품 정보는 아직 가져오지 않았어요. 원본 링크는 보관했어요.";
const kept = "원본 링크는 그대로 보관했어요.";
const statusChip: Record<Metadata["phase"], string | null> = {
  queued: "정보 수집 대기",
  running: "정보 수집 중",
  failed: "정보를 가져오지 못했어요",
  ready: null,
};
const failureReasons: Record<FailureCode, string> = {
  invalid_url: "열 수 없는 주소예요.",
  blocked_address: "안전을 위해 열지 않는 주소예요.",
  dns_failed: "쇼핑몰 주소를 찾지 못했어요.",
  connect_failed: "쇼핑몰에 연결하지 못했어요.",
  timeout: "쇼핑몰이 제때 응답하지 않았어요.",
  too_many_redirects: "페이지가 너무 여러 번 다른 주소로 넘어갔어요.",
  blocked_by_site: "쇼핑몰이 자동 확인을 막았어요.",
  http_status: "쇼핑몰이 페이지를 보여주지 않았어요.",
  unsupported_content: "상품 페이지 형식이 아니에요.",
  too_large: "페이지가 너무 커요.",
  decode_failed: "페이지 내용을 읽지 못했어요.",
  no_product_data: "페이지에서 상품 정보를 찾지 못했어요.",
  attempts_exhausted: "여러 번 시도했지만 가져오지 못했어요.",
  internal: "정보를 가져오는 중에 문제가 생겼어요.",
};

const stalled = (metadata: Metadata) => (metadata.phase === "queued" || metadata.phase === "running") && metadata.stalled;
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

function statusOf(metadata: Metadata): ProductDetailView["status"] {
  if (stalled(metadata)) return { title: "정보 수집이 멈췄어요", detail: `다시 가져오기를 눌러 주세요. ${kept}` };
  switch (metadata.phase) {
    case "queued":
      return { title: "정보 수집 대기", detail: waiting };
    case "running":
      return { title: "정보 수집 중", detail: waiting };
    case "failed":
      return { title: "정보를 가져오지 못했어요", detail: `${failureReasons[metadata.errorCode]} ${kept}` };
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

export function canRetry(product: ProductResponse): boolean {
  return product.metadata.phase === "failed" || stalled(product.metadata);
}

export function toProductCardView(product: ProductResponse, collections: CollectionResponse[]): ProductCardView {
  const [first, ...rest] = namesOf(product, collections);
  return {
    shop: product.shop,
    title: product.title,
    option: product.option || "옵션 미입력",
    status: stalled(product.metadata) ? "정보 수집 멈춤" : statusChip[product.metadata.phase],
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
    canRetry: canRetry(product),
  };
}
