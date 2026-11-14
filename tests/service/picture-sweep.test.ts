import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import { sweepPictures } from "../../src/features/library/application/picture-sweep";
import type { Product } from "../../src/features/library/domain/library";
import {
  createPictureOrphanStore,
  createPictureStore,
  PICTURE_BUCKET,
} from "../../src/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import type { CollectedPage, CollectionJob } from "../../src/features/metadata/application/collection";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";
import { readDatabaseConfig } from "../support/database-config";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
// cleanup removes the test's pictures through the Storage API before it deletes the users.
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const jobs = () => createSupabaseCollectionStore(fixture.owner.client);
const page: CollectedPage = { title: "무선 헤드폰", price: null, imageSourceUrl: "https://cdn.shop.example/headphones.jpg" };
// A 1×1 lossless WebP.
const webp = Buffer.from("524946461a000000574542505650384c0d0000002f0000001007101111888808", "hex");

async function claimed(): Promise<{ product: Product; job: CollectionJob }> {
  const { product } = await createSupabaseLibraryStore(fixture.owner.client)
    .saveLink(toLinkSaveCommand({ url: `https://shop.example/${randomUUID()}`, option: "", collectionIds: [] }));
  const claim = await jobs().claim({ productId: product.id, generation: 1 });
  if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${JSON.stringify(claim)}`);
  const { error } = await fixture.owner.client.storage.from(PICTURE_BUCKET)
    .upload(claim.job.picture, webp, { contentType: "image/webp", upsert: false });
  if (error) throw new Error(`사진을 올리지 못했습니다: ${error.message}`);
  return { product, job: claim.job };
}

const expireLease = (job: CollectionJob) =>
  fixture.admin.query("update moti.metadata_jobs set lease_until = now() - interval '1 second' where id = $1", [job.id]);

async function shown(): Promise<string> {
  const { job } = await claimed();
  await jobs().complete(job, page, { outcome: "copied" });
  return job.picture;
}

async function stillRunning(): Promise<string> {
  const { job } = await claimed();
  await expireLease(job);
  return job.picture;
}

// A run that died after its upload, once the next attempt claimed the job.
async function leftBehind(): Promise<string> {
  const { product, job } = await claimed();
  await expireLease(job);
  await jobs().claim({ productId: product.id, generation: 1 });
  return job.picture;
}

async function aged(name: string, minutes: number): Promise<string> {
  await fixture.admin.query(
    "update storage.objects set created_at = now() - make_interval(mins => $3) where bucket_id = $1 and name = $2",
    [PICTURE_BUCKET, name, minutes],
  );
  return name;
}

async function stored(): Promise<string[]> {
  const { rows } = await fixture.admin.query<{ name: string }>(
    "select name from storage.objects where bucket_id = $1 and starts_with(name, $2) order by name",
    [PICTURE_BUCKET, `${fixture.owner.id}/`],
  );
  return rows.map((row) => row.name);
}

const sweep = (pictures = createPictureStore(fixture.owner.client)) =>
  sweepPictures({ orphans: createPictureOrphanStore(fixture.owner.client), pictures });

describe("실제 저장소를 쓰는 남은 사진 정리", () => {
  it("10분 지난 남은 사본만 지우고 보여주는 사본, 끝나지 않은 작업의 사본, 방금 남은 사본은 그대로 둔다", async () => {
    const kept = [await aged(await shown(), 60), await aged(await stillRunning(), 60), await aged(await leftBehind(), 9)];
    await aged(await leftBehind(), 11);

    expect(await sweep()).toEqual({ kind: "requested", count: 1 });
    expect(await stored()).toEqual(kept.toSorted());
  });

  it("Storage에 닿지 못해 지우지 못해도 예외 없이 끝나고 다음에 열 때 지운다", async () => {
    const kept = await aged(await shown(), 60);
    const orphan = await aged(await leftBehind(), 11);
    const { anonKey } = readDatabaseConfig();
    const { data } = await fixture.owner.client.auth.getSession();
    // The owner's token at an address nothing listens on: the database answers, the Storage call fails to connect.
    const unreachable = createClient("http://127.0.0.1:9", anonKey, { accessToken: async () => data.session!.access_token });

    expect(await sweep(createPictureStore(unreachable))).toEqual({ kind: "requested", count: 1 });
    expect(await stored()).toEqual([kept, orphan].toSorted());

    expect(await sweep()).toEqual({ kind: "requested", count: 1 });
    expect(await stored()).toEqual([kept]);
  });
});
