import type { BrowserContext, Page } from "@playwright/test";

const key = "moti-text-seen";

export async function watchForText(target: BrowserContext | Page, needles: string[]) {
  await target.addInitScript(({ needles, key }) => {
    const check = () => {
      const text = document.body?.innerText ?? "";
      const seen = new Set<string>(JSON.parse(sessionStorage.getItem(key) ?? "[]"));
      for (const needle of needles) if (text.includes(needle)) seen.add(needle);
      if (seen.size > 0) sessionStorage.setItem(key, JSON.stringify([...seen]));
    };
    new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true });
    document.addEventListener("DOMContentLoaded", check);
  }, { needles, key });
}

export async function seenText(page: Page): Promise<string[]> {
  return JSON.parse(await page.evaluate((name) => sessionStorage.getItem(name) ?? "[]", key));
}
