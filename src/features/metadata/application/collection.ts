import type { Product, ProductId } from "../../library/domain/library";
import type { CollectionErrorCode } from "../domain/collection-error";
import type { PageFacts } from "../domain/page-facts";
import { pickSinglePrice, type Price } from "../domain/price";
import type { MetadataRetryCommand, MetadataRetryResult } from "./commands";
import type { ImageCopy, PictureCopier, PictureObject } from "./picture-copy";

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

// Below the 60 s lease and the routes' maxDuration, leaving room for complete() after the picture copy.
export const RUN_BUDGET_MS = 40_000;

export function createCollectionRunner({ store, source, read, copier, now = Date.now }: {
  store: CollectionJobStore;
  source: PageSource;
  read: PageReader;
  copier: PictureCopier;
  now?: () => number;
}) {
  async function fail(job: CollectionJob, code: CollectionErrorCode): Promise<CollectionRun> {
    return settled(await store.fail(job, code), (product) => ({ kind: "failed", code, product }));
  }

  async function collect(job: CollectionJob, deadline: number): Promise<CollectionRun> {
    const fetched = await source.read(job.sourceUrl);
    if (!fetched.ok) return fail(job, fetched.code);
    const outcome = decideOutcome(read(fetched.page.html, fetched.page.url));
    if (outcome.kind === "fail") return fail(job, outcome.code);
    const task = { imageUrl: outcome.page.imageSourceUrl, pageUrl: fetched.page.url, target: job.picture, deadline };
    const settlement = await copier.settleWith(task, (image) => store.complete(job, outcome.page, image));
    return settled(settlement, (product) => ({ kind: "collected", product }));
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
      const deadline = now() + RUN_BUDGET_MS;
      try {
        return await collect(claim.job, deadline);
      } catch {
        try {
          return await fail(claim.job, "internal");
        } catch {
          return { kind: "unavailable" };
        }
      }
    },
  };
}
export type CollectionRunner = ReturnType<typeof createCollectionRunner>;
