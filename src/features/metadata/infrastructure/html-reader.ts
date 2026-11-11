import { Parser } from "htmlparser2";
import type { PageFacts, PriceCandidate } from "../domain/page-facts";
import { cleanTitle } from "../domain/title";

const MAX_DEPTH = 8;
const MAX_NODES = 5000;
const MAX_IMAGE_URL = 4096;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type RawPage = { title: string | null; meta: Map<string, string>; blocks: string[] };

function scan(html: string): RawPage {
  const meta = new Map<string, string>();
  const blocks: string[] = [];
  let title: string | null = null;
  let titleText: string | null = null;
  let script: string | null = null;
  let svgDepth = 0;
  const parser = new Parser({
    onopentag(name, attributes) {
      if (name === "svg") svgDepth += 1;
      if (name === "title" && svgDepth === 0 && title === null) titleText = "";
      if (name === "script" && attributes.type?.split(";")[0].trim().toLowerCase() === "application/ld+json") script = "";
      if (name === "meta") {
        const key = (attributes.property ?? attributes.name)?.trim().toLowerCase();
        if (key && attributes.content !== undefined && !meta.has(key)) meta.set(key, attributes.content);
      }
    },
    ontext(text) {
      if (titleText !== null) titleText += text;
      if (script !== null) script += text;
    },
    onclosetag(name) {
      if (name === "svg" && svgDepth > 0) svgDepth -= 1;
      if (name === "title" && titleText !== null) {
        title = titleText;
        titleText = null;
      }
      if (name === "script" && script !== null) {
        blocks.push(script);
        script = null;
      }
    },
  }, { lowerCaseTags: true, lowerCaseAttributeNames: true });
  parser.end(html);
  return { title, meta, blocks };
}

const asList = (value: Json | undefined): Json[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: Json | undefined): string | null =>
  typeof value === "number" && Number.isFinite(value) ? String(value) : typeof value === "string" ? value : null;

function hasType(node: JsonObject, type: string): boolean {
  return asList(node["@type"]).some((value) => typeof value === "string" && value.split(/[/#]/).at(-1) === type);
}

function findProducts(blocks: string[]): JsonObject[] {
  const products: JsonObject[] = [];
  let budget = MAX_NODES;
  const walk = (value: Json, depth: number) => {
    if (depth > MAX_DEPTH || budget <= 0 || typeof value !== "object" || value === null) return;
    budget -= 1;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (hasType(value, "Product")) products.push(value);
    for (const child of Object.values(value)) walk(child, depth + 1);
  };
  for (const block of blocks) {
    let parsed: Json;
    try {
      parsed = JSON.parse(block) as Json;
    } catch {
      continue;
    }
    walk(parsed, 0);
  }
  return products;
}

function offerPrices(product: JsonObject): PriceCandidate[] {
  const prices: PriceCandidate[] = [];
  const add = (amount: Json | undefined, currency: Json | undefined) => {
    const value = text(amount);
    if (value !== null) prices.push({ amount: value, currency: text(currency) });
  };
  for (const offer of asList(product.offers).filter(isObject)) {
    if (hasType(offer, "AggregateOffer")) {
      const low = text(offer.lowPrice);
      if (low !== null && low === text(offer.highPrice)) add(low, offer.priceCurrency);
    } else if (offer.price !== undefined) {
      add(offer.price, offer.priceCurrency);
    } else {
      for (const specification of asList(offer.priceSpecification).filter(isObject)) {
        add(specification.price, specification.priceCurrency ?? offer.priceCurrency);
      }
    }
  }
  return prices;
}

function imageOf(value: Json | undefined): string | null {
  for (const image of asList(value)) {
    const url = isObject(image) ? text(image.url) : text(image);
    if (url) return url;
  }
  return null;
}

function absoluteImage(value: string | null | undefined, pageUrl: string): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim(), pageUrl);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.href.length > MAX_IMAGE_URL) return null;
    return url.href;
  } catch {
    return null;
  }
}

function metaPrice(meta: Map<string, string>, prefix: string): PriceCandidate[] {
  const amount = meta.get(`${prefix}:price:amount`);
  return amount === undefined ? [] : [{ amount, currency: meta.get(`${prefix}:price:currency`) ?? null }];
}

export function readProductPage(html: string, pageUrl: string): PageFacts {
  const page = scan(html);
  const products = findProducts(page.blocks);
  const names = new Set(products.flatMap((product) => {
    const name = text(product.name);
    const cleaned = name === null ? null : cleanTitle(name);
    return cleaned === null ? [] : [cleaned];
  }));
  // A listing page describes several products; none of their names or prices belongs to the saved link.
  const trusted = names.size > 1 ? [] : products;
  const titles = [names.size === 1 ? [...names][0] : null, page.meta.get("og:title"), page.meta.get("twitter:title"), page.title];
  return {
    title: titles.map((title) => (title ? cleanTitle(title) : null)).find((title) => title !== null) ?? null,
    prices: [...trusted.flatMap(offerPrices), ...metaPrice(page.meta, "product"), ...metaPrice(page.meta, "og")],
    imageUrl: absoluteImage(page.meta.get("og:image"), pageUrl) ??
      absoluteImage(trusted.map((product) => imageOf(product.image)).find(Boolean), pageUrl),
  };
}
