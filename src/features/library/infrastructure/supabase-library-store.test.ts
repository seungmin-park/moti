import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createSupabaseLibraryStore } from "./supabase-library-store";

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
