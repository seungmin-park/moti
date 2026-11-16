// The meta keys the collection's page reader reads (html-reader.ts): the names, the picture and the two price pairs.
// The script sends only these, each once, so nothing else the page states leaves the phone.
export const PAGE_SNAPSHOT_META_KEYS = [
  "og:title",
  "twitter:title",
  "og:image",
  "product:price:amount",
  "product:price:currency",
  "og:price:amount",
  "og:price:currency",
] as const;
export type PageSnapshotMetaKey = (typeof PAGE_SNAPSHOT_META_KEYS)[number];

// What the Safari Shortcut's script hands over from the page the owner is looking at: only the head data the server's
// page reader reads, and the canonical address for the host rule. The script caps every part, and the server checks
// the same caps.
export const PAGE_SNAPSHOT_LIMITS = {
  // The whole snapshot as JSON, in UTF-8 bytes.
  bytes: 64 * 1024,
  url: 4096,
  title: 1000,
  canonical: 4096,
  metas: PAGE_SNAPSHOT_META_KEYS.length,
  metaContent: 4096,
  jsonLd: 16,
  jsonLdBlock: 64 * 1024,
} as const;

// `metas` holds the first value of each read key in the page's order, the one the reader's first-wins rule picks on
// the page. `canonical` is not read as page data: it only lets a link to the page's canonical host count.
export type PageSnapshot = {
  url: string;
  title: string;
  canonical: string;
  metas: [key: PageSnapshotMetaKey, content: string][];
  jsonLd: string[];
};

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ENTITIES[character]);
// Inside a script element only `<` can end it. JSON allows `<` only inside strings, where the escape u+003C written
// as a JSON escape means the same character, so the reader's JSON.parse sees exactly the text the page had (and text that is not JSON stays not JSON).
const escapeScript = (value: string) => value.replaceAll("<", "\\u003c");

// A minimal document with the snapshot's head data in the places the page reader looks. Every value is escaped, so
// nothing received can open, close or add an element.
export function pageSnapshotHtml(snapshot: PageSnapshot): string {
  return [
    "<!doctype html><html><head>",
    `<title>${escapeHtml(snapshot.title)}</title>`,
    snapshot.canonical ? `<link rel="canonical" href="${escapeHtml(snapshot.canonical)}">` : "",
    ...snapshot.metas.map(([key, content]) => `<meta property="${escapeHtml(key)}" content="${escapeHtml(content)}">`),
    ...snapshot.jsonLd.map((block) => `<script type="application/ld+json">${escapeScript(block)}</script>`),
    "</head><body></body></html>",
  ].join("");
}

function hostOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.hostname : null;
  } catch {
    return null;
  }
}

// The snapshot counts only for the page the link names: the link's host is exactly (URL lowercases it) the host of
// the snapshot's address or of the canonical address the same page declares. Safari shares the address it shows or the
// page's canonical one, so a mobile page (m.) shared as its www canonical still counts; a subdomain or another site
// does not. The canonical comes from the same snapshot, so it adds nothing a sender could not already claim in `url`.
export function snapshotMatchesLink(snapshot: Pick<PageSnapshot, "url" | "canonical">, linkUrl: string): boolean {
  const page = hostOf(snapshot.url);
  const link = hostOf(linkUrl);
  if (page === null || link === null) return false;
  return page === link || hostOf(snapshot.canonical) === link;
}
