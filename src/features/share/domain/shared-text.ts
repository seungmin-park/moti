// What a Shortcut hands over: a bare link (Safari, the Musinsa app) or text around one (the Coupang app sends a
// greeting, the product's name and a short link). The link rules themselves stay with parseLink.
export const MAX_SHARED_TEXT_LENGTH = 5000;
export const MAX_SHARED_TITLE_LENGTH = 120;

export type SharedText = { url: string; title: string | null };

const LINK = /https?:\/\/[^\s<>"“”‘’「」『』]+/i;
const LINE_BREAK = /\r\n|[\n\r\u0085\u2028\u2029]/;
const TRAILING = /[.,!?;:'。、]$/;
const PAIRS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

const count = (text: string, character: string) => text.split(character).length - 1;

// Text often closes a sentence or a bracket right after the link; a closing bracket stays when the link opened it.
function trimLink(link: string): string {
  let trimmed = link;
  for (;;) {
    const last = trimmed.at(-1)!;
    const opener = PAIRS[last];
    if (TRAILING.test(trimmed) || (opener && count(trimmed, last) > count(trimmed, opener))) trimmed = trimmed.slice(0, -1);
    else return trimmed;
  }
}

function cleanTitle(line: string): string | null {
  const spaced = line.normalize("NFC").replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim();
  if (!spaced) return null;
  const capped = [...spaced].slice(0, MAX_SHARED_TITLE_LENGTH).join("").trimEnd().normalize("NFC");
  return [...capped].slice(0, MAX_SHARED_TITLE_LENGTH).join("");
}

// The first http(s) link, and as its name the nearest non-empty text before it: the same line's prefix, else the
// closest line above. Lines above the first link hold no link, so none of them is mistaken for a name that is a URL.
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
