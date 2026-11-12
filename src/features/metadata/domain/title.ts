export const MAX_TITLE_LENGTH = 120;

export function cleanTitle(value: string): string | null {
  const text = value
    .normalize("NFC")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const cleaned = [...text].slice(0, MAX_TITLE_LENGTH).join("").trimEnd();
  return cleaned || null;
}
