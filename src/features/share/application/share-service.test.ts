import { describe, expect, it, vi } from "vitest";
import type { PageSnapshot } from "../domain/page-snapshot";
import type { ShareSecret } from "../domain/share-key";
import { toShareLinkAddCommand } from "./commands";
import { createShareLinkService } from "./share-service";
import type { ShareLinkEntry, SharedPage, SharedPageReader } from "./share-store";

const secret = `moti_sk_${"A".repeat(43)}` as ShareSecret;
const page: PageSnapshot = { url: "https://www.market.example/vp/products/7001", title: "와플", canonical: "", metas: [], jsonLd: [] };
const read: SharedPage = {
  title: "로투스 비스코프 와플 초코 300g",
  price: { amountMinor: 12900, currency: "KRW" },
  imageSourceUrl: "https://img.market.example/7001.jpg",
};

function given(reader: SharedPageReader) {
  const add = vi.fn(async (entry: ShareLinkEntry) => { void entry; return { kind: "added" as const }; });
  const readPage = vi.fn(reader);
  return { service: createShareLinkService({ add }, readPage), add, readPage };
}

describe("공유 담기 서비스의 페이지 요약", () => {
  it("Given 링크와 같은 호스트의 요약 When 담으면 Then 읽은 이름이 수집 전 이름이 되고 요약 결과를 첫 작업에 맡긴다", async () => {
    const { service, add, readPage } = given(() => read);
    const command = toShareLinkAddCommand(secret, "쿠팡을 추천합니다!\n와플\nhttps://www.market.example/vp/products/7001", page);

    expect(await service.add(command)).toEqual({ kind: "added" });

    expect(readPage).toHaveBeenCalledExactlyOnceWith(page, "https://www.market.example/vp/products/7001");
    expect(add).toHaveBeenCalledExactlyOnceWith({ secret, link: command.link, title: read.title, sharedPage: read });
  });

  it("Given 쓸 것이 없는 요약 When 담으면 Then 요약 없이 지금처럼 담고 공유한 글의 이름을 쓴다", async () => {
    const { service, add } = given(() => null);
    const command = toShareLinkAddCommand(secret, "와플\nhttps://www.market.example/vp/products/7001", page);

    await service.add(command);

    expect(add).toHaveBeenCalledExactlyOnceWith({ secret, link: command.link, title: "와플", sharedPage: null });
  });

  it("Given 요약을 읽다 예외가 나도 When 담으면 Then 링크는 요약 없이 담는다", async () => {
    const { service, add } = given(() => { throw new Error("reader"); });

    await service.add(toShareLinkAddCommand(secret, "https://www.market.example/vp/products/7001", page));

    expect(add).toHaveBeenCalledWith(expect.objectContaining({ title: null, sharedPage: null }));
  });

  it("Given 요약이 없는 이전 단축어 When 담으면 Then 읽기를 부르지 않는다", async () => {
    const { service, add, readPage } = given(() => read);

    await service.add(toShareLinkAddCommand(secret, "https://www.market.example/vp/products/7001"));

    expect(readPage).not.toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ sharedPage: null }));
  });
});
