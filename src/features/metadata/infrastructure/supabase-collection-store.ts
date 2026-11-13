import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { callRpc, productRowSchema, readResponse, toProduct } from "../../library/infrastructure/supabase-library-store";
import { pictureObjectSchema as pictureObject } from "../../library/infrastructure/product-pictures";
import type { CollectionJob, CollectionJobStore, JobClaim, JobSettlement } from "../application/collection";
const jobRowSchema = z.object({
  id: z.uuid(),
  lease_token: z.uuid(),
  generation: z.number().int().min(1),
  attempts: z.number().int().min(1),
  source_url: z.string().min(1),
  picture: pictureObject,
});
const claimRowSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claimed"), job: jobRowSchema }),
  z.object({ kind: z.literal("skipped"), reason: z.enum(["stale", "busy", "settled"]) }),
  z.object({ kind: z.literal("exhausted"), product: productRowSchema }),
]);
const settlementRowSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("applied"), product: productRowSchema, replaced_picture: pictureObject.nullable().default(null) }),
  z.object({ kind: z.literal("stale") }),
]);
const retryRowSchema = z.object({ kind: z.enum(["requeued", "resumed"]), product: productRowSchema });

type JobRow = z.infer<typeof jobRowSchema>;

function toCollectionJob(row: JobRow): CollectionJob {
  return {
    id: row.id,
    leaseToken: row.lease_token,
    generation: row.generation,
    attempts: row.attempts,
    sourceUrl: row.source_url,
    picture: row.picture,
  };
}

function toSettlement(value: unknown): JobSettlement {
  const row = readResponse(settlementRowSchema, value);
  return row.kind === "applied"
    ? { kind: "applied", product: toProduct(row.product), replacedPicture: row.replaced_picture }
    : { kind: "stale" };
}

export function createSupabaseCollectionStore(client: SupabaseClient): CollectionJobStore {
  return {
    async claim(request): Promise<JobClaim> {
      const row = readResponse(claimRowSchema, await callRpc(client, "moti_metadata_claim", {
        p_product_id: request.productId,
        p_generation: request.generation,
      }));
      if (row.kind === "claimed") return { kind: "claimed", job: toCollectionJob(row.job) };
      if (row.kind === "exhausted") return { kind: "exhausted", product: toProduct(row.product) };
      return row;
    },
    async complete(job, page, image) {
      return toSettlement(await callRpc(client, "moti_metadata_complete", {
        p_job_id: job.id,
        p_lease: job.leaseToken,
        p_title: page.title,
        p_amount_minor: page.price?.amountMinor ?? null,
        p_currency: page.price?.currency ?? null,
        p_image_source_url: page.imageSourceUrl,
        p_image: image.outcome,
        p_image_error_code: image.outcome === "failed" ? image.code : null,
      }));
    },
    async fail(job, code) {
      return toSettlement(await callRpc(client, "moti_metadata_fail", {
        p_job_id: job.id,
        p_lease: job.leaseToken,
        p_error_code: code,
      }));
    },
    async retry(command) {
      const row = readResponse(retryRowSchema, await callRpc(client, "moti_metadata_retry", {
        p_product_id: command.productId,
        p_expected_generation: command.expectedGeneration,
      }));
      return { kind: row.kind, product: toProduct(row.product) };
    },
  };
}
