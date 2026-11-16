import { decideOutcome, type PageReader } from "../../metadata/application/collection";
import type { SharedPageReader } from "../application/share-store";
import { pageSnapshotHtml, snapshotMatchesLink } from "../domain/page-snapshot";

// Reads the Safari Shortcut's snapshot exactly as a collection reads a fetched page: the snapshot becomes a minimal,
// fully escaped document, the collection's reader reads it at the snapshot's address, and the collection's rules decide
// the name, the one price and the picture's address. A snapshot of another host, or one that names no product, counts
// for nothing, and the add goes on as without one.
export function createSharedPageReader(read: PageReader): SharedPageReader {
  return (page, sourceUrl) => {
    if (!snapshotMatchesLink(page.url, sourceUrl)) return null;
    const outcome = decideOutcome(read(pageSnapshotHtml(page), page.url));
    return outcome.kind === "complete" ? outcome.page : null;
  };
}
