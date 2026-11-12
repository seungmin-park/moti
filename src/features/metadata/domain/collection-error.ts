// Every reason a collection can end without product data. `retryable` marks the ones a later attempt may fix.
export const collectionErrors = {
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
  no_product_data: { retryable: false },
  attempts_exhausted: { retryable: true },
  internal: { retryable: true },
} as const satisfies Record<string, { retryable: boolean }>;

export type CollectionErrorCode = keyof typeof collectionErrors;
export const collectionErrorCodes = Object.keys(collectionErrors) as [CollectionErrorCode, ...CollectionErrorCode[]];

export function isCollectionErrorCode(value: unknown): value is CollectionErrorCode {
  return typeof value === "string" && Object.hasOwn(collectionErrors, value);
}
