import { PAGE_SNAPSHOT_LIMITS, PAGE_SNAPSHOT_META_KEYS } from "../domain/page-snapshot";

// The script the owner pastes into the Safari Shortcut's "웹 페이지에서 JavaScript 실행" action. Shortcuts runs it in the
// page Safari is showing, as the body of a function that must call completion() once; its result becomes the request's
// `page`. It sends only what the server uses: location.href, document.title, the first canonical link's href (for the
// host rule only), the first content of each meta key the page reader reads (og:title, twitter:title, og:image and the
// product:/og: price amount and currency pairs, keyed by property, else name, as the reader does), and the
// application/ld+json blocks that name a Product (the reader finds products anywhere in a block, @graph included, so a
// block is kept whole). A script's text is read only after its type is ld+json. No other meta, block, body text, script,
// cookie, storage or network. Every part has the cap the server checks (PAGE_SNAPSHOT_LIMITS), and the whole stays
// within 64 KiB as UTF-8 JSON: product blocks first, then metas, each kept only if it fits. It always completes, with
// an empty snapshot when the page is not what it expects. Plain ASCII, so it pastes cleanly.
export const PAGE_SNAPSHOT_SCRIPT = `var KEYS = ${JSON.stringify(PAGE_SNAPSHOT_META_KEYS)};
var LIMITS = ${JSON.stringify(PAGE_SNAPSHOT_LIMITS)};
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
  var seen = {};
  tags("meta").forEach(function (meta) {
    var key = meta.getAttribute("property");
    if (key === null) key = meta.getAttribute("name");
    key = text(key).trim().toLowerCase();
    var content = meta.getAttribute("content");
    if (KEYS.indexOf(key) < 0 || seen[key] === true || typeof content !== "string") return;
    seen[key] = true;
    metas.push([key, cut(content, LIMITS.metaContent)]);
  });
  var products = [];
  tags("script").forEach(function (script) {
    var type = text(script.getAttribute("type")).split(";")[0].trim().toLowerCase();
    if (type !== "application/ld+json") return;
    var block = text(script.textContent);
    if (block.length <= LIMITS.jsonLdBlock && block.indexOf("Product") >= 0) products.push(block);
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
  if (size(page) <= LIMITS.bytes) result = page;
} catch (error) {
  result = { url: "", title: "", canonical: "", metas: [], jsonLd: [] };
}
completion(JSON.stringify(result));
`;
