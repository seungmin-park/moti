// Every way a request to the shop can fail. Page and picture fetches share them; `retryable` marks the ones a
// later attempt may fix.
const fetchErrors = {
  invalid_url: { retryable: false },
  blocked_address: { retryable: false },
  dns_failed: { retryable: true },
  connect_failed: { retryable: true },
  timeout: { retryable: true },
  too_many_redirects: { retryable: false },
  blocked_by_site: { retryable: true },
  http_status: { retryable: true },
  unsupported_content: { retryable: false },
  too_large: { retryable: false },
  decode_failed: { retryable: false },
} as const satisfies Record<string, { retryable: boolean }>;

// Every reason a collection can end without product data.
export const collectionErrors = {
  ...fetchErrors,
  no_product_data: { retryable: false },
  attempts_exhausted: { retryable: true },
  internal: { retryable: true },
} as const satisfies Record<string, { retryable: boolean }>;

// Every reason a page that was read ends without a stored copy of its picture. The name and price still count.
export const imageErrors = {
  ...fetchErrors,
  unreadable_image: { retryable: false },
  upload_failed: { retryable: true },
  internal: { retryable: true },
} as const satisfies Record<string, { retryable: boolean }>;

export type FetchErrorCode = keyof typeof fetchErrors;
export type CollectionErrorCode = keyof typeof collectionErrors;
export type ImageErrorCode = keyof typeof imageErrors;
export const collectionErrorCodes = Object.keys(collectionErrors) as [CollectionErrorCode, ...CollectionErrorCode[]];
export const imageErrorCodes = Object.keys(imageErrors) as [ImageErrorCode, ...ImageErrorCode[]];

export function isCollectionErrorCode(value: unknown): value is CollectionErrorCode {
  return typeof value === "string" && Object.hasOwn(collectionErrors, value);
}
