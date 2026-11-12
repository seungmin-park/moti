// Reads real product pages with the production page source and reader, and prints what collection would record.
// Not part of CI: it reaches the public internet. Usage: node scripts/check-real-pages.mjs <url> [url...]
import { registerHooks } from "node:module";

// The source uses extensionless relative imports (bundler resolution); map them to the .ts files for Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
      return nextResolve(`${specifier}.ts`, context);
    }
  },
});

const metadata = new URL("../src/features/metadata/", import.meta.url);
const { createSafePageSource } = await import(new URL("infrastructure/safe-fetch.ts", metadata).href);
const { strictFetchPolicy } = await import(new URL("infrastructure/address-policy.ts", metadata).href);
const { readProductPage } = await import(new URL("infrastructure/html-reader.ts", metadata).href);
const { pickSinglePrice } = await import(new URL("domain/price.ts", metadata).href);

const urls = process.argv.slice(2);
if (urls.length === 0) {
  console.error("Usage: node scripts/check-real-pages.mjs <product-url> [product-url...]");
  process.exit(2);
}

const source = createSafePageSource({ policy: strictFetchPolicy });
const statusClass = (status) => (status === null ? "-" : `${Math.floor(status / 100)}xx`);
const quoted = (value) => (value === null ? "-" : JSON.stringify(value));

for (const url of urls) {
  let host = "-";
  try {
    host = new URL(url).host;
  } catch {
    // Reported below as invalid_url by the page source itself.
  }
  const result = await source.read(url);
  if (!result.ok) {
    console.log([`host=${host}`, `outcome=${result.code}`, `status=${statusClass(result.status)}`, "title=-", "price=-"].join("\t"));
    continue;
  }
  const facts = readProductPage(result.page.html, result.page.url);
  const choice = pickSinglePrice(facts.prices);
  const price = choice.kind === "single" ? `${choice.price.currency}:${choice.price.amountMinor}(minor)` : choice.kind;
  console.log([
    `host=${host}`,
    `outcome=${facts.title === null ? "no_product_data" : "ok"}`,
    `status=${statusClass(result.page.status)}`,
    `title=${quoted(facts.title)}`,
    `price=${price}`,
  ].join("\t"));
}
