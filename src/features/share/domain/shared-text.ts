// What a Shortcut hands over: a bare link (Safari, the Musinsa app) or text around one (the Coupang app sends a
// greeting, the product's name and a short link). The link rules themselves stay with parseLink.
export const MAX_SHARED_TEXT_LENGTH = 5000;
export const MAX_SHARED_TITLE_LENGTH = 120;

export type SharedText = { url: string; title: string | null };

// A link ends at whitespace, <>", curly quotes, full-width punctuation and brackets, and Hangul syllables or jamo. A raw
// Hangul character is never part of a shared link: apps send non-ASCII paths percent-encoded, and Korean text often
// runs straight on after the link ("…/p/1입니다").
const LINK = /https?:\/\/[^\s<>"“”‘’，。！？（）【】〈〉《》「」『』、\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7A3\uD7B0-\uD7FF]+/i;
const LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;
const TRAILING = /[.,!?;:']/;
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
// Text that opens a bracket right before the link: "와플 (https://…)" or "와플【https://…】".
const OPENERS = new Set([..."([{（【〈《「『"]);
const HAS_LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

// Text often closes a sentence or a bracket right after the link; a closing bracket stays when the link opened it.
// The brackets are counted once and the counts follow the trimming, so the cost is linear in the link's length.
function trimLink(link: string): string {
  const counts: Record<string, number> = {};
  for (const character of link) counts[character] = (counts[character] ?? 0) + 1;
  let end = link.length;
  for (;;) {
    const last = link[end - 1];
    const opener = PAIRS[last];
    if (TRAILING.test(last)) end -= 1;
    else if (opener && counts[last] > (counts[opener] ?? 0)) {
      counts[last] -= 1;
      end -= 1;
    } else return link.slice(0, end);
  }
}

function withoutOpeners(text: string): string {
  let end = text.length;
  while (end > 0 && OPENERS.has(text[end - 1])) end -= 1;
  return text.slice(0, end);
}

function cleanTitle(line: string): string | null {
  const spaced = withoutOpeners(line.normalize("NFC").replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim()).trim();
  // A bullet ("▶"), a label ("링크:", "상품 보기:") or emoji alone names nothing; the name is further up.
  if (!HAS_LETTER_OR_NUMBER.test(spaced) || /[:：]$/u.test(spaced)) return null;
  const capped = [...spaced].slice(0, MAX_SHARED_TITLE_LENGTH).join("").trimEnd().normalize("NFC");
  return [...capped].slice(0, MAX_SHARED_TITLE_LENGTH).join("");
}

// The first http(s) link, and as its name the nearest text before it that names something: the same line's prefix, else
// the closest such line above. Text with no letter or number, or ending in a colon, is skipped. Lines above the first link hold no link, so none of them is mistaken for a name that is a URL.
export function readSharedText(value: string): SharedText | null {
  if (!value.isWellFormed() || [...value].length > MAX_SHARED_TEXT_LENGTH) return null;
  const match = LINK.exec(value);
  if (!match) return null;
  const url = trimLink(match[0]);
  const lines = value.slice(0, match.index).split(LINE_BREAK);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const title = cleanTitle(lines[index]);
    if (title) return { url, title };
  }
  return { url, title: null };
}
