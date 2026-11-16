import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toLinkSaveCommand } from "../../src/features/library/application/commands";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { createSupabaseCollectionStore } from "../../src/features/metadata/infrastructure/supabase-collection-store";
import { toShareLinkAddCommand } from "../../src/features/share/application/commands";
import { parseShareSecret } from "../../src/features/share/domain/share-key";
import { createSupabaseShareLinkStore } from "../../src/features/share/infrastructure/supabase-share-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const library = () => createSupabaseLibraryStore(fixture.owner.client);
const jobs = () => createSupabaseCollectionStore(fixture.owner.client);

async function rpc<T = unknown>(name: string, parameters: Record<string, unknown> = {}, client: SupabaseClient = fixture.anonymous) {
  const { data, error } = await client.rpc(name, parameters);
  return { data: data as T, code: error?.code ?? null };
}

async function issue(): Promise<string> {
  const { data, code } = await rpc<{ secret: string }>("moti_share_key_issue", { p_replaces: null }, fixture.owner.client);
  if (code) throw new Error(`moti_share_key_issue 실패: ${code}`);
  return data.secret;
}

function linkOf(url: string) {
  const { sourceUrl, identityUrl, option, shop } = toLinkSaveCommand({ url, option: "", collectionIds: [] });
  return { p_source_url: sourceUrl, p_identity_url: identityUrl, p_option: option, p_shop: shop };
}

const page = { title: "로투스 비스코프 와플 초코 300g", amount: 12900, currency: "KRW", image: "https://img.market.example/7001.jpg" };
type Page = { title?: unknown; amount?: unknown; currency?: unknown; image?: unknown };
const url = "https://www.market.example/vp/products/7001";

// What the share route sends with a snapshot: the read name as the product's first name, and the read page for the job.
const addWithPage = (key: string, link = url, shared: Page = page) => rpc("moti_share_add", {
  p_key: key,
  ...linkOf(link),
  p_title: shared.title,
  p_shared_title: shared.title,
  p_shared_amount_minor: shared.amount,
  p_shared_currency: shared.currency,
  p_shared_image_url: shared.image,
});

type SharedColumns = {
  status: string;
  shared_title: string | null;
  shared_amount_minor: string | null;
  shared_currency: string | null;
  shared_image_url: string | null;
};

async function jobsOf(link = url) {
  const { rows } = await fixture.admin.query<SharedColumns>(
    `select j.status, j.shared_title, j.shared_amount_minor, j.shared_currency, j.shared_image_url
     from moti.metadata_jobs j join moti.products p on p.id = j.product_id
     where p.owner_id = $1 and p.source_url = $2 order by j.created_at`,
    [fixture.owner.id, link],
  );
  return rows;
}

const productOf = async (link = url) => (await library().snapshot()).products.find((product) => product.sourceUrl === link)!;

async function claimed(link = url) {
  const product = await productOf(link);
  const claim = await jobs().claim({ productId: product.id, generation: product.metadata.generation });
  if (claim.kind !== "claimed") throw new Error(`작업을 맡지 못했습니다: ${claim.kind}`);
  return claim.job;
}

describe("Safari 단축어가 읽은 페이지를 첫 작업에 맡기기", () => {
  it("새로 담은 상품의 첫 작업에만 읽은 페이지를 두고, 상품은 읽은 이름으로 보인다", async () => {
    const key = await issue();

    expect(await addWithPage(key)).toMatchObject({ code: null, data: { kind: "added" } });

    expect(await jobsOf()).toEqual([{
      status: "queued",
      shared_title: page.title,
      shared_amount_minor: "12900",
      shared_currency: "KRW",
      shared_image_url: page.image,
    }]);
    expect(await productOf()).toMatchObject({ title: page.title, metadata: { phase: "queued", attempts: 0 } });
  });

  it("이미 담긴 상품은 읽은 페이지로 덮지 않고 작업도 그대로다", async () => {
    const key = await issue();
    await library().saveLink(toLinkSaveCommand({ url, option: "", collectionIds: [] }));
    const before = await productOf();

    expect(await addWithPage(key, `${url}?utm_source=share`)).toMatchObject({ code: null, data: { kind: "duplicate" } });

    expect(await jobsOf()).toEqual([{ status: "queued", shared_title: null, shared_amount_minor: null, shared_currency: null, shared_image_url: null }]);
    expect(await productOf()).toEqual(before);
  });

  it.each([
    ["이름 없음", { ...page, title: null }],
    ["앞뒤 공백 이름", { ...page, title: " 와플 " }],
    ["121자 이름", { ...page, title: "가".repeat(121) }],
    ["통화 없는 가격", { ...page, currency: null }],
    ["가격 없는 통화", { ...page, amount: null }],
    ["0원", { ...page, amount: 0 }],
    ["소문자 통화", { ...page, currency: "krw" }],
    ["http(s)가 아닌 사진 주소", { ...page, image: "javascript:alert(1)" }],
    ["계정이 든 사진 주소", { ...page, image: "https://u:p@img.market.example/7001.jpg" }],
  ])("검사를 지나지 못하는 읽은 페이지(%s)는 버리고 링크는 담는다", async (_name, shared) => {
    const key = await issue();

    expect(await addWithPage(key, url, shared)).toMatchObject({ code: null, data: { kind: "added" } });

    expect(await jobsOf()).toEqual([{ status: "queued", shared_title: null, shared_amount_minor: null, shared_currency: null, shared_image_url: null }]);
  });

  it("가격과 사진이 없는 읽은 페이지도 이름만으로 맡긴다", async () => {
    const key = await issue();
    await addWithPage(key, url, { title: page.title, amount: null, currency: null, image: null });
    expect(await jobsOf()).toEqual([{ status: "queued", shared_title: page.title, shared_amount_minor: null, shared_currency: null, shared_image_url: null }]);
  });

  it("작업을 맡으면 읽은 페이지를 함께 받고, 끝내면 지운다", async () => {
    const key = await issue();
    await addWithPage(key);

    const job = await claimed();

    expect(job.sharedPage).toEqual({
      title: page.title,
      price: { amountMinor: 12900, currency: "KRW" },
      imageSourceUrl: page.image,
    });
    expect(await jobs().complete(job, job.sharedPage!, { outcome: "failed", code: "blocked_by_site" })).toMatchObject({ kind: "applied" });
    expect(await jobsOf()).toEqual([{ status: "succeeded", shared_title: null, shared_amount_minor: null, shared_currency: null, shared_image_url: null }]);
    expect(await productOf()).toMatchObject({
      title: page.title,
      metadata: { phase: "ready" },
      lastSuccessfulPrice: expect.objectContaining({ amountMinor: 12900, currency: "KRW" }),
    });
  });

  it("실패로 끝나도 읽은 페이지를 지우고, 다시 가져오기의 새 작업에는 없다", async () => {
    const key = await issue();
    await addWithPage(key);
    const job = await claimed();

    await jobs().fail(job, "internal");
    const failed = await productOf();
    await jobs().retry({ productId: failed.id, expectedGeneration: failed.metadata.generation });

    expect(await jobsOf()).toEqual([
      { status: "failed", shared_title: null, shared_amount_minor: null, shared_currency: null, shared_image_url: null },
      { status: "queued", shared_title: null, shared_amount_minor: null, shared_currency: null, shared_image_url: null },
    ]);
    expect((await claimed()).sharedPage).toBeNull();
  });

  it("임대가 끝나 다시 맡은 같은 세대의 작업은 읽은 페이지를 그대로 받는다", async () => {
    const key = await issue();
    await addWithPage(key);
    await claimed();
    await fixture.admin.query(
      "update moti.metadata_jobs set lease_until = now() - interval '1 second' where owner_id = $1", [fixture.owner.id],
    );

    expect((await claimed()).sharedPage).toMatchObject({ title: page.title });
  });

  it("읽은 페이지가 없는 작업은 sharedPage가 null이다", async () => {
    await library().saveLink(toLinkSaveCommand({ url, option: "", collectionIds: [] }));
    expect((await claimed()).sharedPage).toBeNull();
  });

  it("예약 작업자는 읽은 페이지가 있는 작업을 맡지 않고 소유자의 수집에 남긴다", async () => {
    const key = await issue();
    await addWithPage(key);
    await library().saveLink(toLinkSaveCommand({ url: "https://shop.example/desk", option: "", collectionIds: [] }));
    const issued = await rpc<{ secret: string }>("moti_worker_key_issue", { p_replaces: null }, fixture.owner.client);
    const begun = await rpc<{ run: string; lease: string }>("moti_worker_begin", { p_key: issued.data.secret });
    const step = { p_key: issued.data.secret, p_run: begun.data.run, p_lease: begun.data.lease };

    const first = await rpc<{ kind: string; source_url?: string }>("moti_worker_next", step);
    const second = await rpc<{ kind: string; source_url?: string }>("moti_worker_next", step);

    expect(first.data).toMatchObject({ kind: "collection", source_url: "https://shop.example/desk" });
    expect(second.data.kind).not.toBe("collection");
    expect(await jobsOf()).toEqual([expect.objectContaining({ status: "queued", shared_title: page.title })]);
  });

  it("읽은 페이지 인자를 모르는 이전 앱의 호출도 그대로 담는다", async () => {
    const key = await issue();
    expect(await rpc("moti_share_add", { p_key: key, ...linkOf(url), p_title: "와플" })).toMatchObject({ code: null, data: { kind: "added" } });
    expect(await jobsOf()).toEqual([{ status: "queued", shared_title: null, shared_amount_minor: null, shared_currency: null, shared_image_url: null }]);
  });

  it("어댑터는 읽은 페이지를 함께 담고 수집 어댑터가 같은 값으로 돌려받는다", async () => {
    const secret = parseShareSecret(await issue())!;
    const sharedPage = { title: page.title, price: { amountMinor: 12900, currency: "KRW" }, imageSourceUrl: page.image };
    const { link } = toShareLinkAddCommand(secret, url);

    expect(await createSupabaseShareLinkStore(fixture.anonymous).add({ secret, link, title: page.title, sharedPage })).toEqual({ kind: "added" });

    expect((await claimed()).sharedPage).toEqual(sharedPage);
  });

  it("읽은 페이지 열에 직접 준 권한은 저장 키 역할의 넣기와 예약 작업자의 거르기뿐이다", async () => {
    const { rows } = await fixture.admin.query<{ grantee: string; privilege: string; column: string }>(
      `select a.grantee::regrole::text as grantee, a.privilege_type as privilege, t.attname as column
       from pg_attribute t join pg_class c on c.oid = t.attrelid, aclexplode(t.attacl) a
       where c.oid = 'moti.metadata_jobs'::regclass and t.attname like 'shared_%' order by 1, 3, 2`,
    );
    expect(rows).toEqual([
      { grantee: "moti_share", privilege: "INSERT", column: "shared_amount_minor" },
      { grantee: "moti_share", privilege: "INSERT", column: "shared_currency" },
      { grantee: "moti_share", privilege: "INSERT", column: "shared_image_url" },
      { grantee: "moti_share", privilege: "INSERT", column: "shared_title" },
      { grantee: "moti_worker", privilege: "SELECT", column: "shared_title" },
    ]);
  });
});
