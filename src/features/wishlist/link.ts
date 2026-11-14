export const MAX_LINK_LENGTH = 4096;
export const MAX_OPTION_LENGTH = 120;

// Query names that say how a link was shared, not which product it is: ad click ids, the Musinsa app's AppsFlyer
// short-link redirect and Naver's search tracking. utm_* and af_* are matched by prefix.
const TRACKING_KEYS = new Set([
  "gclid", "fbclid", "msclkid",
  "is_retargeting", "shortlink", "source_caller", "onelink_id",
  "nl-query", "nl-au",
]);

export type SavedLink = {
  sourceUrl: string;
  identityUrl: string;
  option: string;
  shop: string;
};

export type LinkResult =
  | { ok: true; link: SavedLink }
  | { ok: false; field: "url" | "option"; message: string };

export function parseLink(url: unknown, rawOption: unknown): LinkResult {
  const invalidUrl: LinkResult = {
    ok: false,
    field: "url",
    message: "로그인 정보가 없는 http:// 또는 https:// 링크를 입력해 주세요.",
  };
  if (typeof url !== "string" || !url.isWellFormed()) return invalidUrl;
  const sourceUrl = url.trim();
  if (
    [...sourceUrl].length > MAX_LINK_LENGTH ||
    [...sourceUrl].some((character) => {
      const point = character.codePointAt(0)!;
      return point < 32 || point === 127;
    })
  ) return invalidUrl;

  let source: URL;
  try {
    source = new URL(sourceUrl);
  } catch {
    return invalidUrl;
  }
  if (
    !["http:", "https:"].includes(source.protocol) ||
    !source.hostname ||
    source.username ||
    source.password
  ) return invalidUrl;

  if (typeof rawOption !== "string" || !rawOption.isWellFormed()) {
    return { ok: false, field: "option", message: "올바른 옵션을 입력해 주세요." };
  }
  const option = rawOption.trim().normalize("NFC");
  if (option.includes("\u0000") || [...option].length > MAX_OPTION_LENGTH) {
    return { ok: false, field: "option", message: "옵션은 120자까지 입력해 주세요." };
  }

  const identity = new URL(source);
  const keys = [...new Set(identity.searchParams.keys())];
  // AppsFlyer's pid names a media source, but alone it is a common product-id parameter, so it only counts with af_*.
  const appsFlyer = keys.some((key) => /^af_/i.test(key));
  for (const key of keys) {
    const lower = key.toLowerCase();
    if (/^(utm|af)_/.test(lower) || TRACKING_KEYS.has(lower) || (appsFlyer && lower === "pid")) {
      identity.searchParams.delete(key);
    }
  }
  identity.searchParams.sort();
  return {
    ok: true,
    link: {
      sourceUrl,
      identityUrl: identity.href,
      option,
      shop: source.hostname.replace(/^www\./, ""),
    },
  };
}
