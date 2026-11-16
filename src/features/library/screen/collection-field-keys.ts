export type CollectionFieldKey = "create" | "hold" | "cancel" | null;

// What a key in the detail's "새 컬렉션 이름" field does. Enter creates only when 만들기 could be pressed; otherwise it
// is held so it neither creates nor submits the details form. Escape closes only the field. While a Korean syllable
// is still being composed, Enter and Escape belong to the input method.
export function collectionFieldKey(
  event: { key: string; isComposing: boolean; keyCode: number },
  canCreate: boolean,
): CollectionFieldKey {
  if (event.isComposing || event.keyCode === 229) return null;
  if (event.key === "Enter") return canCreate ? "create" : "hold";
  if (event.key === "Escape") return "cancel";
  return null;
}
