import { MAX_TITLE_LENGTH, normalizeTitle } from "../../wishlist/product-fields";

export { MAX_TITLE_LENGTH };

// A page's name can be longer than a saved title, so collection cuts it where the owner's edit would be refused.
export function cleanTitle(value: string): string | null {
  const cleaned = [...normalizeTitle(value)].slice(0, MAX_TITLE_LENGTH).join("").trimEnd();
  return cleaned || null;
}
