import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import type { Product, ProductId } from "../../src/features/library/domain/library";
import { PICTURE_BUCKET } from "../../src/features/library/infrastructure/product-pictures";
import {
  createSupabaseLibraryStore,
  createSupabasePicturePasteStore,
} from "../../src/features/library/infrastructure/supabase-library-store";
import type { CollectedPage, CollectionJob } from "../../src/features/metadata/application/collection";
import type { PictureObject } from "../../src/features/metadata/application/picture-copy";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

// A 1×1 lossless WebP.
const webp = Buffer.from("524946461a000000574542505650384c0d0000002f0000001007101111888808", "hex");
const page: CollectedPage = { title: "무선 헤드폰", price: { amountMinor: 289000, currency: "KRW" }, imageSourceUrl: "https://cdn.shop.example/a.jpg" };
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const pastes = (client: SupabaseClient = fixture.owner.client) => createSupabasePicturePasteStore(client);
const jobs = () => createSupabaseCollectionStore(fixture.owner.client);
const bucket = (client: SupabaseClient = fixture.owner.client) => client.storage.from(PICTURE_BUCKET);

async function saved(): Promise<Product> {
  return (await createSupabaseLibraryStore(fixture.owner.client)
    .saveLink(toLinkSaveCommand({ url: `https://shop.example/${randomUUID()}`, option: "", collectionIds: [] }))).product;
}

async function upload(name: string, client: SupabaseClient = fixture.owner.client) {
  return (await bucket(client).upload(name, webp, { contentType: "image/webp", upsert: false })).error;
}

// What the paste route does: reserve, upload with the owner's token, point the product at it.
async function pasted(product: Product): Promise<{ name: PictureObject; product: Product; replaced: PictureObject | null }> {
  const name = await pastes().reserve(product.id);
  expect(await upload(name)).toBeNull();
  const applied = await pastes().apply(product.id, name);
  if (applied.kind !== "applied") throw new Error("붙여 넣은 사진을 걸지 못했습니다.");
  return { name, product: applied.product, replaced: applied.replaced };
}

// A collection run that copied a picture, settled as the owner's runner settles it.
async function collected(product: Product, generation = product.metadata.generation): Promise<{ job: CollectionJob; replaced: string | null }> {
  const claim = await jobs().claim({ productId: product.id, generation });
  if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${JSON.stringify(claim)}`);
  expect(await upload(claim.job.picture)).toBeNull();
  const settled = await jobs().complete(claim.job, page, { outcome: "copied" });
  if (settled.kind !== "applied") throw new Error("수집 결과를 남기지 못했습니다.");
  return { job: claim.job, replaced: settled.replacedPicture };
}

async function located(product: Product, client: SupabaseClient = fixture.owner.client) {
  const { data, error } = await client.rpc("moti_picture_locate", { p_product_id: product.id });
  return { data, code: error?.code ?? null };
}

async function shown(product: Product) {
  const library = await createSupabaseLibraryStore(fixture.owner.client).snapshot();
  return library.products.find((item) => item.id === product.id)!;
}

async function aged(name: string, minutes: number) {
  const { rowCount } = await fixture.admin.query(
    "update storage.objects set created_at = now() - make_interval(mins => $3) where bucket_id = $1 and name = $2",
    [PICTURE_BUCKET, name, minutes],
  );
  expect(rowCount).toBe(1);
}

async function orphans(): Promise<string[]> {
  const { data, error } = await fixture.owner.client.rpc("moti_picture_orphans", { p_limit: 200 });
  if (error) throw new Error(error.code);
  return data as string[];
}

async function stored(): Promise<string[]> {
  const { rows } = await fixture.admin.query<{ name: string }>(
    "select name from storage.objects where bucket_id = $1 and starts_with(name, $2) order by name",
    [PICTURE_BUCKET, `${fixture.owner.id}/`],
  );
  return rows.map((row) => row.name);
}

const expireReservation = (product: Product) =>
  fixture.admin.query("update moti.products set paste_reserved_until = now() - interval '1 second' where id = $1", [product.id]);

describe("사진 붙여넣기 예약과 걸기", () => {
  it("예약한 이름에 소유자 토큰으로 올리고 걸면 상품이 붙여 넣은 사진을 보이고 revision이 오른다", async () => {
    const product = await saved();

    const name = await pastes().reserve(product.id);
    expect(name).toMatch(new RegExp(`^${fixture.owner.id}/${product.id}/${uuid}-1\\.webp$`));
    expect(await upload(name)).toBeNull();
    const applied = await pastes().apply(product.id, name);

    const paste = name.split("/")[2].replace(/-1\.webp$/, "");
    expect(applied).toEqual({
      kind: "applied",
      replaced: null,
      product: expect.objectContaining({ revision: product.revision + 1, picture: { version: paste, pasted: true } }),
    });
    expect(await located(product)).toEqual({ data: name, code: null });
    expect((await shown(product)).picture).toEqual({ version: paste, pasted: true });
    const { rows } = await fixture.admin.query(
      "select paste_reserved_id, paste_reserved_until, pasted_picture_version is not null as versioned from moti.products where id = $1",
      [product.id],
    );
    expect(rows).toEqual([{ paste_reserved_id: null, paste_reserved_until: null, versioned: true }]);
  });

  it("예약하지 않은 이름, 지난 예약, 다른 상품의 이름에는 Storage가 쓰기를 거절한다", async () => {
    const product = await saved();
    const other = await saved();
    expect(await upload(`${fixture.owner.id}/${product.id}/${randomUUID()}-1.webp`)).not.toBeNull();

    const name = await pastes().reserve(product.id);
    expect(await upload(name.replace(product.id, other.id))).not.toBeNull();
    await expireReservation(product);
    expect(await upload(name)).not.toBeNull();
    expect(await stored()).toEqual([]);
  });

  it("다른 계정은 소유자의 예약에 쓰지 못한다", async () => {
    const product = await saved();
    const name = await pastes().reserve(product.id);

    expect(await upload(name, fixture.stranger.client)).not.toBeNull();
    expect(await upload(name, fixture.anonymous)).not.toBeNull();
    expect(await stored()).toEqual([]);
  });

  it("지난 예약, 새 예약이 대신한 예약, 다른 이름으로는 걸지 못하고 상품은 그대로다", async () => {
    const product = await saved();
    const first = await pastes().reserve(product.id);
    expect(await upload(first)).toBeNull();
    const second = await pastes().reserve(product.id);

    expect(await pastes().apply(product.id, first)).toEqual({ kind: "stale" });
    expect(await pastes().apply(product.id, `${fixture.owner.id}/${product.id}/${randomUUID()}-1.webp` as PictureObject)).toEqual({ kind: "stale" });
    expect(await upload(second)).toBeNull();
    await expireReservation(product);
    expect(await pastes().apply(product.id, second)).toEqual({ kind: "stale" });
    expect(await shown(product)).toMatchObject({ revision: product.revision, picture: null });
  });

  it("올리지 않은 예약을 걸면 M0002이다", async () => {
    const product = await saved();
    const name = await pastes().reserve(product.id);

    const { error } = await fixture.owner.client.rpc("moti_picture_paste", { p_product_id: product.id, p_object: name });
    expect(error?.code).toBe("M0002");
    await expect(pastes().apply(product.id, name)).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("다른 소유자·없는 상품은 거절하고, 소유자가 아니면 M0001, 익명은 42501이다", async () => {
    const product = await saved();

    await expect(pastes().reserve(randomUUID() as ProductId)).rejects.toMatchObject({ code: "product_missing" });
    await expect(pastes().clear(randomUUID() as ProductId)).rejects.toMatchObject({ code: "product_missing" });
    for (const [client, code] of [[fixture.stranger.client, "M0001"], [fixture.anonymous, "42501"]] as const) {
      for (const [name, parameters] of [
        ["moti_picture_paste_reserve", { p_product_id: product.id }],
        ["moti_picture_paste", { p_product_id: product.id, p_object: "x" }],
        ["moti_picture_paste_clear", { p_product_id: product.id }],
      ] as const) {
        expect((await client.rpc(name, parameters)).error?.code).toBe(code);
      }
    }
    const { rows } = await fixture.admin.query("select paste_reserved_id from moti.products where id = $1", [product.id]);
    expect(rows).toEqual([{ paste_reserved_id: null }]);
  });

  it("붙여 넣은 사진이 Storage에서 바뀌면 서명할 이름을 주지 않는다", async () => {
    const product = await saved();
    await pasted(product);
    await fixture.admin.query("update moti.products set pasted_picture_version = 'other' where id = $1", [product.id]);

    expect(await located(product)).toEqual({ data: null, code: null });
  });
});

describe("붙여 넣은 사진과 수집", () => {
  it("수집·다시 가져오기가 새 사본을 가져와도 붙여 넣은 사진이 보이고, 지우면 마지막으로 가져온 사본으로 돌아간다", async () => {
    const product = await saved();
    const first = await collected(product);
    const paste = await pasted(product);

    // "다시 가져오기": a new generation reads the page and copies the picture again.
    await fixture.admin.query(
      "update moti.products set metadata_image = 'failed', metadata_image_error_code = 'timeout' where id = $1", [product.id],
    );
    const retried = await jobs().retry({ productId: product.id, expectedGeneration: 1 });
    const second = await collected(retried.product);

    expect(second.replaced).toBe(first.job.picture);
    expect(await located(product)).toEqual({ data: paste.name, code: null });
    expect((await shown(product)).picture).toEqual({ version: paste.name.split("/")[2].replace(/-1\.webp$/, ""), pasted: true });
    expect(await shown(product)).toMatchObject({ metadata: { phase: "ready", generation: 2, image: { outcome: "copied" } } });

    const cleared = await pastes().clear(product.id);

    expect(cleared).toEqual({
      replaced: paste.name,
      product: expect.objectContaining({ revision: paste.product.revision + 1, picture: { version: second.job.id, pasted: false } }),
    });
    expect(await located(product)).toEqual({ data: second.job.picture, code: null });
  });

  it("가져온 사진이 없는 상품에서 지우면 사진이 없고, 붙여 넣은 사진이 없으면 아무것도 바꾸지 않는다", async () => {
    const product = await saved();
    const paste = await pasted(product);

    const cleared = await pastes().clear(product.id);
    expect(cleared).toMatchObject({ replaced: paste.name, product: { picture: null } });
    expect(await pastes().clear(product.id)).toEqual({ replaced: null, product: cleared.product });
    expect(await located(product)).toEqual({ data: null, code: null });
  });

  it("작업자 역할은 붙여 넣은 사진 열을 읽지도 쓰지도 못한다", async () => {
    const { rows } = await fixture.admin.query<{ column: string; select: boolean; update: boolean }>(
      `select c.column_name as column,
       has_column_privilege('moti_worker', 'moti.products', c.column_name, 'select') as select,
       has_column_privilege('moti_worker', 'moti.products', c.column_name, 'update') as update
       from information_schema.columns c
       where c.table_schema = 'moti' and c.table_name = 'products' and (c.column_name like 'paste%')
       order by c.column_name`,
    );
    expect(rows.map((row) => row.column)).toEqual([
      "paste_reserved_id", "paste_reserved_until", "pasted_at", "pasted_picture_id", "pasted_picture_version",
    ]);
    expect(rows.every((row) => !row.select && !row.update)).toBe(true);
  });
});

describe("붙여 넣은 사진과 남은 사진 정리", () => {
  it("새로 붙여 넣으면 대신한 사본을 돌려주고 소유자가 지울 수 있지만 지금 붙여 넣은 사진은 지우지 못한다", async () => {
    const product = await saved();
    const first = await pasted(product);
    const second = await pasted(product);

    expect(second.replaced).toBe(first.name);
    await bucket().remove([first.name, second.name]);

    expect(await stored()).toEqual([second.name]);
  });

  it("대신한·지운 붙여넣기와 지난 예약의 업로드는 10분 뒤 정리 대상이고, 지금 붙여 넣은 사진과 살아 있는 예약은 아니다", async () => {
    const swapped = await saved();
    const replacedPaste = (await pasted(swapped)).name;
    const current = (await pasted(swapped)).name;

    const cleared = await saved();
    const clearedPaste = (await pasted(cleared)).name;
    await pastes().clear(cleared.id);

    const lapsed = await saved();
    const lapsedName = await pastes().reserve(lapsed.id);
    expect(await upload(lapsedName)).toBeNull();
    await expireReservation(lapsed);

    const live = await saved();
    const liveName = await pastes().reserve(live.id);
    expect(await upload(liveName)).toBeNull();

    const deleted = await saved();
    const deletedPaste = (await pasted(deleted)).name;
    await fixture.admin.query("delete from moti.products where id = $1", [deleted.id]);

    const kept = [current, liveName];
    const returned = [replacedPaste, clearedPaste, lapsedName, deletedPaste];
    for (const name of [...kept, ...returned]) await aged(name, 11);

    expect(await orphans()).toEqual(returned.toSorted());
    await bucket().remove(await stored());
    expect(await stored()).toEqual(kept.toSorted());
  });

  it("방금 대신한 붙여넣기는 10분이 지나기 전에는 정리 대상이 아니다", async () => {
    const product = await saved();
    const first = await pasted(product);
    await pasted(product);
    await aged(first.name, 9);

    expect(await orphans()).toEqual([]);
  });
});

describe("붙여넣기 RPC의 권한", () => {
  it("공개 RPC는 RPC 역할이 소유한 보안 정의자이고 authenticated만 실행하며 search_path를 비운다", async () => {
    const { rows } = await fixture.admin.query<{
      proname: string; owner: string; prosecdef: boolean; config: string[] | null; anon: boolean; authenticated: boolean; service: boolean;
    }>(
      `select p.proname, r.rolname as owner, p.prosecdef, p.proconfig as config,
       has_function_privilege('anon', p.oid, 'execute') as anon,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('service_role', p.oid, 'execute') as service
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on r.oid = p.proowner
       where n.nspname = 'public' and p.proname like 'moti_picture_paste%' order by p.proname`,
    );
    expect(rows).toEqual(["moti_picture_paste", "moti_picture_paste_clear", "moti_picture_paste_reserve"].map((proname) => ({
      proname, owner: "moti_rpc", prosecdef: true, config: ["search_path=\"\""], anon: false, authenticated: true, service: false,
    })));
  });

  it("내부 함수는 RPC 역할만 실행하고 공개 REST에 드러나지 않는다", async () => {
    const { rows } = await fixture.admin.query<{ proname: string; rpc: boolean; authenticated: boolean; worker: boolean }>(
      `select p.proname,
       has_function_privilege('moti_rpc', p.oid, 'execute') as rpc,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
       has_function_privilege('moti_worker', p.oid, 'execute') as worker
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'moti' and p.proname in ('pasted_picture', 'paste_reservation', 'picture_paste_reserve', 'picture_paste', 'picture_paste_clear')
       order by p.proname`,
    );
    expect(rows).toEqual(["paste_reservation", "pasted_picture", "picture_paste", "picture_paste_clear", "picture_paste_reserve"]
      .map((proname) => ({ proname, rpc: true, authenticated: false, worker: false })));
    const product = await saved();
    const direct = await fixture.owner.client.schema("moti").rpc("picture_paste_reserve", { p_owner: fixture.owner.id, p_product_id: product.id });
    expect(direct.error?.code).toBe("PGRST106");
  });
});
