import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { PictureObject } from "../../metadata/application/picture-copy";
import type { ProductId } from "../domain/library";
import { createSupabaseLibraryStore, createSupabasePicturePasteStore } from "./supabase-library-store";

// A product row as a database without 20261123000000_owner_price.sql returns it: no wish_* keys at all.
const productRow = {
  id: "11111111-1111-4111-8111-111111111111",
  source_url: "https://shop.example/p/1",
  identity_url: "https://shop.example/p/1",
  option: "",
  shop: "shop.example",
  title: "키보드 스위치",
  note: "",
  revision: 2,
  collection_ids: [],
  created_at: "2026-11-11T00:00:00+00:00",
  updated_at: "2026-11-11T00:00:00+00:00",
  purchase_status: "wish",
  purchased_on: null,
  purchased_amount_minor: null,
  purchased_currency: null,
  metadata_phase: "ready",
  metadata_generation: 1,
  metadata_attempts: 1,
  metadata_error_code: null,
  metadata_stalled: false,
  metadata_completed_at: "2026-11-11T00:00:00+00:00",
  metadata_image: "absent",
  metadata_image_error_code: null,
  last_success_amount_minor: 300,
  last_success_currency: "KRW",
  last_success_at: "2026-11-11T00:00:00+00:00",
  price_checked_at: null,
  price_check_code: null,
  picture_version: null,
};

const backupRow = {
  source_url: "https://shop.example/p/1",
  identity_url: "https://shop.example/p/1",
  option: "",
  shop: "shop.example",
  title: "키보드 스위치",
  owner_title: null,
  note: "",
  collection_names: [],
  created_at: "2026-11-11T00:00:00+00:00",
  purchase_status: "wish",
  purchased_on: null,
  purchased_amount_minor: null,
  purchased_currency: null,
  last_success_amount_minor: 300,
  last_success_currency: "KRW",
  last_success_at: "2026-11-11T00:00:00+00:00",
};

function answering(responses: Record<string, unknown>): SupabaseClient {
  return {
    rpc: async (name: string) => ({ data: responses[name], error: null }),
  } as unknown as SupabaseClient;
}

const pictureVersion = "33333333-3333-4333-8333-333333333333";
const owner = "44444444-4444-4444-8444-444444444444";
const pasteName = `${owner}/${productRow.id}/55555555-5555-4555-8555-555555555555-1.webp`;

describe("내가 살 가격 열이 없는 DB의 응답", () => {
  it("Given wish_* 열이 없는 상품 행 When 보관함과 링크 저장을 읽으면 Then 내가 살 가격은 null이다", async () => {
    const store = createSupabaseLibraryStore(answering({
      moti_snapshot: { products: [productRow], collections: [] },
      moti_save_link: { kind: "duplicate", product: productRow },
    }));

    const library = await store.snapshot();
    const saved = await store.saveLink({
      sourceUrl: productRow.source_url, identityUrl: productRow.identity_url, option: "", shop: productRow.shop, collectionIds: [],
    });

    expect(library.products[0]).toMatchObject({ title: "키보드 스위치", wishPrice: null, lastSuccessfulPrice: { amountMinor: 300 } });
    expect(saved.product.wishPrice).toBeNull();
  });

  it("Given wish_* 열이 없는 백업 행 When 내보내면 Then 내가 살 가격은 null이다", async () => {
    const store = createSupabaseLibraryStore(answering({ moti_backup: { collections: [], products: [backupRow] } }));

    const backup = await store.exportLibrary();

    expect(backup.products[0]).toMatchObject({ collectedTitle: "키보드 스위치", wishPrice: null });
  });

  it("Given 한쪽 wish_* 열만 있는 행 When 읽으면 Then 손상된 응답으로 거절한다", async () => {
    const store = createSupabaseLibraryStore(answering({
      moti_snapshot: { products: [{ ...productRow, wish_amount_minor: 3000 }], collections: [] },
    }));

    await expect(store.snapshot()).rejects.toMatchObject({ code: "storage_unavailable" });
  });
});

describe("붙여 넣은 사진 열이 없는 DB의 응답", () => {
  it("Given picture_pasted 칸이 없는 상품 행 When 읽으면 Then 가져온 사본으로 읽는다", async () => {
    const store = createSupabaseLibraryStore(answering({
      moti_snapshot: { products: [{ ...productRow, picture_version: pictureVersion }], collections: [] },
    }));

    expect((await store.snapshot()).products[0].picture).toEqual({ version: pictureVersion, pasted: false });
  });

  it("Given 붙여 넣은 사진이라는 행 When 읽으면 Then 붙여 넣은 사진으로 읽는다", async () => {
    const store = createSupabaseLibraryStore(answering({
      moti_snapshot: { products: [{ ...productRow, picture_version: pictureVersion, picture_pasted: true }], collections: [] },
    }));

    expect((await store.snapshot()).products[0].picture).toEqual({ version: pictureVersion, pasted: true });
  });

  it("Given 사진 없이 붙여 넣었다는 행 When 읽으면 Then 손상된 응답으로 거절한다", async () => {
    const store = createSupabaseLibraryStore(answering({
      moti_snapshot: { products: [{ ...productRow, picture_pasted: true }], collections: [] },
    }));

    await expect(store.snapshot()).rejects.toMatchObject({ code: "storage_unavailable" });
  });
});

describe("사진 붙여넣기 저장소", () => {
  const pasted = { ...productRow, revision: 3, picture_version: pictureVersion, picture_pasted: true };

  it("Given 예약·걸기·지우기 응답 When 읽으면 Then 이름과 상품과 대신한 사본으로 바꾼다", async () => {
    const store = createSupabasePicturePasteStore(answering({
      moti_picture_paste_reserve: pasteName,
      moti_picture_paste: { kind: "applied", product: pasted, replaced_picture: null },
      moti_picture_paste_clear: { product: productRow, replaced_picture: pasteName },
    }));
    const productId = productRow.id as ProductId;

    expect(await store.reserve(productId)).toBe(pasteName);
    expect(await store.apply(productId, pasteName as PictureObject)).toMatchObject({
      kind: "applied", replaced: null, product: { revision: 3, picture: { version: pictureVersion, pasted: true } },
    });
    expect(await store.clear(productId)).toMatchObject({ replaced: pasteName, product: { picture: null } });
  });

  it("Given 예약이 지난 걸기 응답 When 읽으면 Then stale이다", async () => {
    const store = createSupabasePicturePasteStore(answering({ moti_picture_paste: { kind: "stale" } }));

    expect(await store.apply(productRow.id as ProductId, pasteName as PictureObject)).toEqual({ kind: "stale" });
  });

  it("Given moti가 만들지 않은 이름 When 예약을 읽으면 Then 손상된 응답으로 거절한다", async () => {
    const store = createSupabasePicturePasteStore(answering({ moti_picture_paste_reserve: "../other-owner/file.png" }));

    await expect(store.reserve(productRow.id as ProductId)).rejects.toMatchObject({ code: "storage_unavailable" });
  });
});
