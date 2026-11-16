// What the Safari Shortcut's script hands over from the page the owner is looking at: only the head data the server's
// page reader already understands. The script caps every part, and the server checks the same caps.
export const PAGE_SNAPSHOT_LIMITS = {
  // The whole snapshot as JSON, in UTF-8 bytes.
  bytes: 64 * 1024,
  url: 4096,
  title: 1000,
  canonical: 4096,
  metas: 100,
  metaKey: 200,
  metaContent: 4096,
  jsonLd: 16,
  jsonLdBlock: 64 * 1024,
} as const;

// `metas` keeps the page's order, so the reader's first-wins rule picks the same value it would on the page.
export type PageSnapshot = {
  url: string;
  title: string;
  canonical: string;
  metas: [key: string, content: string][];
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

// The snapshot counts only for the page the link names: the same host, exactly (URL lowercases it). Safari shares the
// address it shows, so its snapshot and its link have the same host; a subdomain or another site does not count.
export function snapshotMatchesLink(snapshotUrl: string, linkUrl: string): boolean {
  const page = hostOf(snapshotUrl);
  return page !== null && page === hostOf(linkUrl);
}
