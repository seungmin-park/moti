import { describe, expect, it } from "vitest";
import { MAX_PICTURE_PASTE_BYTES } from "../presentation/library-dto";
import {
  PASTE_MAX_EDGE,
  PASTE_SEND_BYTES,
  clipboardProblem,
  fitWithin,
  noImageMessage,
  pickPastedImage,
  uploadPlan,
} from "./picture-paste";

const file = (type: string, size = 1000) => ({ type, size });

describe("붙여 넣은 사진 고르기", () => {
  it("Given 글과 사진이 함께 든 클립보드 When 고르면 Then 첫 사진 파일이다", () => {
    const png = file("image/png");
    expect(pickPastedImage([file("text/plain"), file("text/html"), png, file("image/jpeg")])).toBe(png);
  });

  it.each([
    ["빈 클립보드", []],
    ["글만", [file("text/plain")]],
    ["형식을 모르는 파일", [file("")]],
  ])("Given %s When 고르면 Then 사진이 없다", (_name, files) => {
    expect(pickPastedImage(files)).toBeNull();
  });

  it("사진이 없을 때의 안내는 복사부터 다시 하라고 말한다", () => {
    expect(noImageMessage).toBe("클립보드에 사진이 없어요. 상품 사진을 복사한 뒤 다시 붙여 넣어 주세요.");
  });
});

describe("올리기 전 줄이기", () => {
  it.each(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"])(
    "Given 2MiB 이하의 %s When 계획하면 Then 그대로 보낸다", (type) => {
      expect(uploadPlan(file(type, PASTE_SEND_BYTES))).toBe("send");
    },
  );

  it.each([
    ["2MiB를 넘는 PNG", file("image/png", PASTE_SEND_BYTES + 1)],
    ["iPhone 사진 HEIC", file("image/heic", 300_000)],
    ["TIFF", file("image/tiff", 300_000)],
    ["BMP", file("image/bmp", 300_000)],
  ])("Given %s When 계획하면 Then 브라우저에서 JPEG로 줄여 보낸다", (_name, image) => {
    expect(uploadPlan(image)).toBe("shrink");
  });

  it("그대로 보내는 크기는 서버 한도와 Vercel 4.5MB 요청 한도보다 작다", () => {
    expect(PASTE_SEND_BYTES).toBe(2 * 1024 * 1024);
    expect(PASTE_SEND_BYTES).toBeLessThan(MAX_PICTURE_PASTE_BYTES);
    expect(MAX_PICTURE_PASTE_BYTES).toBeLessThan(4.5 * 1000 * 1000);
  });

  it.each([
    [{ width: 4032, height: 3024 }, { width: 1600, height: 1200 }],
    [{ width: 3024, height: 4032 }, { width: 1200, height: 1600 }],
    [{ width: 800, height: 600 }, { width: 800, height: 600 }],
    [{ width: 5000, height: 3 }, { width: 1600, height: 1 }],
  ])("Given %o When 맞추면 Then 긴 변이 1600px 안인 %o이다", (size, fitted) => {
    expect(PASTE_MAX_EDGE).toBe(1600);
    expect(fitWithin(size, PASTE_MAX_EDGE)).toEqual(fitted);
  });
});

describe("클립보드 읽기 실패", () => {
  it.each([
    [new DOMException("denied", "NotAllowedError"), "클립보드를 읽도록 허용되지 않았어요. 붙여넣기 칸을 길게 누르거나 ⌘V·Ctrl+V로 붙여 넣어 주세요."],
    [new DOMException("no data", "DataError"), "클립보드에 사진이 없어요. 상품 사진을 복사한 뒤 다시 붙여 넣어 주세요."],
    [new Error("boom"), "클립보드를 읽지 못했어요. 붙여넣기 칸을 길게 누르거나 ⌘V·Ctrl+V로 붙여 넣어 주세요."],
  ])("Given %o When 안내하면 Then %s", (error, message) => {
    expect(clipboardProblem(error)).toBe(message);
  });
});
