import { describe, expect, it } from "vitest";
import { LibraryError } from "../../library/domain/library";
import { toMetadataRetryCommand } from "./commands";

const productId = "ca47b10d-e052-4910-bdba-75ae5eb99620";

describe("다시 가져오기 명령", () => {
  it("Given 저장할 수 있는 가장 큰 세대 When 명령을 만들면 Then 그 세대를 담는다", () => {
    expect(toMetadataRetryCommand(productId.toUpperCase(), 2147483647))
      .toEqual({ productId, expectedGeneration: 2147483647 });
  });

  it("Given 저장할 수 있는 범위를 넘는 세대 When 명령을 만들면 Then 잘못된 입력으로 거절한다", () => {
    let error: unknown;
    try { toMetadataRetryCommand(productId, 2147483648); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(LibraryError);
    expect(error).toMatchObject({ code: "invalid_input" });
  });
});
