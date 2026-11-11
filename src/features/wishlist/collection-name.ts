export const MAX_COLLECTION_NAME_LENGTH = 40;

export type CollectionNameResult = { ok: true; name: string } | { ok: false; message: string };

export function parseCollectionName(input: unknown): CollectionNameResult {
  if (typeof input !== "string" || !input.isWellFormed() || input.includes("\u0000")) {
    return { ok: false, message: "컬렉션 이름을 확인해 주세요." };
  }
  const name = input.trim().normalize("NFC");
  if (!name || [...name].length > MAX_COLLECTION_NAME_LENGTH) {
    return { ok: false, message: "컬렉션 이름은 1~40자로 입력해 주세요." };
  }
  return { ok: true, name };
}
