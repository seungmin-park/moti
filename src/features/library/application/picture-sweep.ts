import type { PictureObject, PictureStore } from "../../metadata/application/picture-copy";

// The database's answer to which of the owner's copies no product shows, no running job may still record, and that
// are older than ten minutes: the objects Storage lets the owner discard, with a margin.
export interface PictureOrphanStore {
  find(limit: number): Promise<PictureObject[]>;
}

// One round per open, never a loop: a discard Storage refuses would hand back the same names until the deadline. Two
// bounded calls fit the wake's window, and a larger backlog shrinks by this much each time the owner opens moti.
export const SWEEP_BATCH = 200;

// What a sweep did, never which copies: how many names it handed to Storage, or the step that threw.
export type PictureSweepResult = { kind: "requested"; count: number } | { kind: "failed"; step: "find" | "discard" };

// Runs after the owner's wake response. Storage checks each name again with the owner's token. Never throws.
export async function sweepPictures({ orphans, pictures }: { orphans: PictureOrphanStore; pictures: PictureStore }): Promise<PictureSweepResult> {
  let found: PictureObject[];
  try {
    found = await orphans.find(SWEEP_BATCH);
  } catch {
    return { kind: "failed", step: "find" };
  }
  if (found.length === 0) return { kind: "requested", count: 0 };
  try {
    await pictures.discard(found);
  } catch {
    return { kind: "failed", step: "discard" };
  }
  return { kind: "requested", count: found.length };
}
