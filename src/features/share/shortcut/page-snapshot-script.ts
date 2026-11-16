// The script the owner pastes into the Safari Shortcut's "웹 페이지에서 JavaScript 실행" action. Shortcuts runs it in the
// page Safari is showing, as the body of a function that must call completion() once; its result becomes the request's
// `page`. It only reads the head data the server's page reader understands: document.title, location.href, the
// canonical link, product meta tags (og:, product:, twitter: and itemprop) and the ld+json blocks. No body text, other
// scripts, cookies, storage or network. Every part has the cap the server checks (PAGE_SNAPSHOT_LIMITS), and the whole
// stays within 64 KiB as UTF-8 JSON: product blocks first, then metas, then other blocks, each kept only if it fits.
// It always completes, with an empty snapshot when the page is not what it expects. Plain ASCII, so it pastes cleanly.
export const PAGE_SNAPSHOT_SCRIPT = `var LIMITS = { bytes: 65536, url: 4096, title: 1000, canonical: 4096, metas: 100, metaKey: 200, metaContent: 4096, jsonLd: 16, jsonLdBlock: 65536 };
var result = { url: "", title: "", canonical: "", metas: [], jsonLd: [] };
function text(value) {
  return typeof value === "string" ? value : "";
}
function cut(value, max) {
  var end = Math.min(value.length, max);
  var last = value.charCodeAt(end - 1);
  if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}
function whole(value, max) {
  return value.length <= max ? value : "";
}
function size(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}
function tags(name) {
  return Array.prototype.slice.call(document.getElementsByTagName(name));
}
try {
  var page = { url: whole(text(location.href), LIMITS.url), title: cut(text(document.title), LIMITS.title), canonical: "", metas: [], jsonLd: [] };
  tags("link").forEach(function (link) {
    var rel = text(link.getAttribute("rel")).toLowerCase().split(/\\s+/);
    if (page.canonical === "" && rel.indexOf("canonical") >= 0) page.canonical = whole(text(link.getAttribute("href")), LIMITS.canonical);
  });
  var metas = [];
  tags("meta").forEach(function (meta) {
    var key = text(meta.getAttribute("property")) || text(meta.getAttribute("name"));
    var shown = /^(og|product|twitter):/i.test(key);
    if (!shown) {
      key = text(meta.getAttribute("itemprop"));
      shown = key !== "";
    }
    var content = meta.getAttribute("content");
    if (shown && key.length <= LIMITS.metaKey && typeof content === "string") metas.push([key, cut(content, LIMITS.metaContent)]);
  });
  var products = [];
  var others = [];
  tags("script").forEach(function (script) {
    var type = text(script.getAttribute("type")).split(";")[0].trim().toLowerCase();
    var block = text(script.textContent);
    if (type !== "application/ld+json" || block.length > LIMITS.jsonLdBlock) return;
    (block.indexOf("Product") >= 0 ? products : others).push(block);
  });
  var used = size(page);
  var fit = function (items, into, max) {
    items.forEach(function (item) {
      var more = size(item) + (into.length > 0 ? 1 : 0);
      if (into.length < max && used + more <= LIMITS.bytes) {
        into.push(item);
        used += more;
      }
    });
  };
  fit(products, page.jsonLd, LIMITS.jsonLd);
  fit(metas, page.metas, LIMITS.metas);
  fit(others, page.jsonLd, LIMITS.jsonLd);
  if (size(page) <= LIMITS.bytes) result = page;
} catch (error) {
  result = { url: "", title: "", canonical: "", metas: [], jsonLd: [] };
}
completion(JSON.stringify(result));
`;
