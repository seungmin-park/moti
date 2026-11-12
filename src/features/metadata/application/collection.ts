import type { Product, ProductId } from "../../library/domain/library";
import type { CollectionErrorCode } from "../domain/collection-error";
import type { PageFacts } from "../domain/page-facts";
import { pickSinglePrice, type Price } from "../domain/price";
import type { MetadataRetryCommand, MetadataRetryResult } from "./commands";
import type { ImageCopy, PictureObject } from "./picture-copy";

export type CollectionRequest = { productId: ProductId; generation: number };
export type CollectionJob = {
  id: string;
  leaseToken: string;
  generation: number;
  attempts: number;
  sourceUrl: string;
  picture: PictureObject;
};
export type JobClaim =
  | { kind: "claimed"; job: CollectionJob }
  | { kind: "skipped"; reason: "stale" | "busy" | "settled" }
  | { kind: "exhausted"; product: Product };
export type CollectedPage = { title: string; price: Price | null; imageSourceUrl: string | null };
export type JobSettlement = { kind: "applied"; product: Product; replacedPicture: PictureObject | null } | { kind: "stale" };

export interface CollectionJobStore {
  claim(request: CollectionRequest): Promise<JobClaim>;
  complete(job: CollectionJob, page: CollectedPage, image: ImageCopy): Promise<JobSettlement>;
  fail(job: CollectionJob, code: CollectionErrorCode): Promise<JobSettlement>;
  retry(command: MetadataRetryCommand): Promise<MetadataRetryResult>;
}

export type FetchedPage = { html: string; url: string; status: number };
export type PageRead = { ok: true; page: FetchedPage } | { ok: false; code: CollectionErrorCode; status: number | null };

// The boundary to the shop: everything past it is someone else's server.
export interface PageSource {
  read(url: string): Promise<PageRead>;
}
export type PageReader = (html: string, pageUrl: string) => PageFacts;

export type CollectionOutcome = { kind: "complete"; page: CollectedPage } | { kind: "fail"; code: "no_product_data" };
export type CollectionRun =
  | { kind: "collected"; product: Product }
  | { kind: "failed"; code: CollectionErrorCode; product: Product }
  | { kind: "skipped"; reason: "stale" | "busy" | "settled" }
  | { kind: "exhausted"; product: Product }
  | { kind: "stale" }
  | { kind: "unavailable" };

export function decideOutcome(facts: PageFacts): CollectionOutcome {
  if (facts.title === null) return { kind: "fail", code: "no_product_data" };
  const choice = pickSinglePrice(facts.prices);
  return {
    kind: "complete",
    page: { title: facts.title, price: choice.kind === "single" ? choice.price : null, imageSourceUrl: facts.imageUrl },
  };
}

function settled(settlement: JobSettlement, run: (product: Product) => CollectionRun): CollectionRun {
  return settlement.kind === "applied" ? run(settlement.product) : { kind: "stale" };
}

export function createCollectionRunner({ store, source, read }: {
  store: CollectionJobStore;
  source: PageSource;
  read: PageReader;
}) {
  async function collect(job: CollectionJob): Promise<CollectionRun> {
    const fetched = await source.read(job.sourceUrl);
    const outcome: CollectionOutcome | { kind: "fail"; code: CollectionErrorCode } = fetched.ok
      ? decideOutcome(read(fetched.page.html, fetched.page.url))
      : { kind: "fail", code: fetched.code };
    if (outcome.kind === "complete") {
      const image: ImageCopy = outcome.page.imageSourceUrl === null ? { outcome: "absent" } : { outcome: "failed", code: "internal" };
      return settled(await store.complete(job, outcome.page, image), (product) => ({ kind: "collected", product }));
    }
    const { code } = outcome;
    return settled(await store.fail(job, code), (product) => ({ kind: "failed", code, product }));
  }

  return {
    // Runs after the response is sent, so it reports instead of throwing: nobody is left to catch it.
    async run(request: CollectionRequest): Promise<CollectionRun> {
      let claim: JobClaim;
      try {
        claim = await store.claim(request);
      } catch {
        return { kind: "unavailable" };
      }
      if (claim.kind !== "claimed") return claim;
      try {
        return await collect(claim.job);
      } catch {
        try {
          return settled(await store.fail(claim.job, "internal"), (product) => ({ kind: "failed", code: "internal", product }));
        } catch {
          return { kind: "unavailable" };
        }
      }
    },
  };
}
export type CollectionRunner = ReturnType<typeof createCollectionRunner>;
