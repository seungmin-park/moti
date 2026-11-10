import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { toCollectionCreateCommand, toLinkSaveCommand } from "../../src/features/library/application/commands";
import { createLibraryService } from "../../src/features/library/application/library-service";
import { createSupabaseLibraryStore } from "../../src/features/library/infrastructure/supabase-library-store";
import { createDatabaseFixture, type DatabaseFixture } from "../support/database";

let fixture: DatabaseFixture;
beforeEach(async () => { fixture = await createDatabaseFixture(); });
afterEach(async () => {
  if (!fixture) return;
  try { await fixture.cleanup(); } finally { await fixture.close(); }
});

const libraryService = () => createLibraryService(createSupabaseLibraryStore(fixture.owner.client));
const service = () => {
  const library = libraryService();
  return {
    snapshot: () => library.snapshot(),
    saveLink: async (input: unknown) => library.saveLink(toLinkSaveCommand(input)),
    createCollection: async (name: unknown) => library.createCollection(toCollectionCreateCommand(name)),
  };
};
const link = { url: "https://example.com/item?size=M", option: "", collectionIds: [] as string[] };

describe("실제 저장소를 사용하는 서비스", () => {
  it("생성한 컬렉션과 링크를 서비스 인스턴스를 바꾸어 다시 읽는다", async () => {
    const collection = await service().createCollection(" 가방 ");
    const saved = await service().saveLink({
      ...link,
      url: " https://example.com/item?size=M&utm_source=one ",
      option: " 가 ",
      collectionIds: [collection.id, collection.id.toUpperCase()],
    });
    expect(collection.name).toBe("가방");
    expect(saved.product).toMatchObject({
      sourceUrl: "https://example.com/item?size=M&utm_source=one",
      identityUrl: "https://example.com/item?size=M",
      option: "가",
      collectionIds: [collection.id],
    });
    expect(await service().snapshot()).toEqual({ products: [saved.product], collections: [collection] });
  });

  it("컬렉션 생성은 링크 저장 취소와 무관한 별도 커밋이다", async () => {
    const collection = await service().createCollection("나중에 담기");
    expect(await service().snapshot()).toEqual({ products: [], collections: [collection] });
  });

  it("컬렉션 생성 뒤 잘못된 링크 저장이 실패해도 컬렉션은 남는다", async () => {
    const collection = await service().createCollection("기다릴 선물");
    await expect(service().saveLink({ ...link, collectionIds: [collection.id, randomUUID()] }))
      .rejects.toMatchObject({ code: "collection_missing" });
    expect(await service().snapshot()).toEqual({ products: [], collections: [collection] });
  });

  it.each([
    { url: "javascript:alert(1)", field: "url" },
    { option: "가".repeat(121), field: "option" },
    { collectionIds: ["not-a-uuid"], field: "collection" },
  ])("잘못된 $field 입력은 실제 저장소에 상품이나 작업을 만들지 않는다", async ({ field, ...input }) => {
    await expect(service().saveLink({ ...link, ...input }))
      .rejects.toMatchObject({ code: "invalid_input", field });
    const result = await fixture.admin.query(
      `select
       (select count(*)::int from moti.products where owner_id = $1) as products,
       (select count(*)::int from moti.metadata_jobs where owner_id = $1) as jobs`, [fixture.owner.id],
    );
    expect(result.rows).toEqual([{ products: 0, jobs: 0 }]);
  });

  it("잘못된 컬렉션 이름은 실제 저장을 남기지 않는다", async () => {
    await expect(service().createCollection(" ")).rejects.toMatchObject({ code: "invalid_input", field: "collection" });
    expect((await fixture.admin.query("select id from moti.collections where owner_id = $1", [fixture.owner.id])).rows)
      .toEqual([]);
  });

  it("추적 query와 NFC 옵션만 다른 재요청은 중복 결과를 반환한다", async () => {
    const saved = await service().saveLink({ ...link, option: "가" });
    const result = await service().saveLink({ ...link, url: `${link.url}&utm_source=retry`, option: " 가 " });
    expect(result).toEqual({ kind: "duplicate", product: saved.product });
  });

  it("같은 옵션 재요청과 다른 옵션 요청이 엇갈려도 상품 둘만 남는다", async () => {
    const results = await Promise.all([
      service().saveLink({ ...link, option: "M" }),
      service().saveLink({ ...link, option: "L" }),
      service().saveLink({ ...link, option: " M " }),
      service().saveLink({ ...link, option: " L " }),
    ]);
    expect(results.filter((result) => result.kind === "added")).toHaveLength(2);
    expect(results.filter((result) => result.kind === "duplicate")).toHaveLength(2);
    expect((await service().snapshot()).products.map((product) => product.option).toSorted()).toEqual(["L", "M"]);
  });

  it("허용하지 않은 사용자는 서비스에서도 데이터에 접근하지 못한다", async () => {
    const denied = createLibraryService(createSupabaseLibraryStore(fixture.stranger.client));
    await expect(denied.snapshot()).rejects.toMatchObject({ code: "unauthorized" });
    await expect(denied.saveLink(toLinkSaveCommand(link))).rejects.toMatchObject({ code: "unauthorized" });
    await expect(denied.createCollection({ name: "내 컬렉션 아님" })).rejects.toMatchObject({ code: "unauthorized" });
  });
});
