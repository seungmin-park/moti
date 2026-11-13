import { runWithin, type CollectionRequest } from "../../metadata/application/collection";
import type { PictureStore } from "../../metadata/application/picture-copy";
import type { LibraryRestoreResult } from "./commands";

export const RESTORE_COLLECTION_CONCURRENCY = 2;
export const RESTORE_COLLECTION_WINDOW_MS = 40_000;
export const DISCARD_BATCH = 1000;

// After a restore commits: discard the copies the deleted products showed, then collect the restored products that wait
// for it, newest first, starting none after the window. The rest stall and keep the existing retry. Never throws.
export async function followUpRestore(
  result: LibraryRestoreResult,
  { pictures, collect, now }: { pictures: PictureStore; collect: (request: CollectionRequest) => Promise<unknown>; now: () => number },
): Promise<void> {
  const started = now();
  for (let index = 0; index < result.replacedPictures.length; index += DISCARD_BATCH) {
    await pictures.discard(result.replacedPictures.slice(index, index + DISCARD_BATCH)).catch(() => undefined);
  }
  const waiting = result.library.products.flatMap(({ id, metadata }) =>
    metadata.phase === "queued" ? [{ productId: id, generation: metadata.generation }] : []);
  await runWithin(waiting, collect, {
    concurrency: RESTORE_COLLECTION_CONCURRENCY,
    deadline: started + RESTORE_COLLECTION_WINDOW_MS,
    now,
  });
}
