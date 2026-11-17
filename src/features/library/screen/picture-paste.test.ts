import { describe, expect, it } from "vitest";
import { pictureLimits } from "../../metadata/domain/picture";
import { MAX_PICTURE_PASTE_BYTES } from "../presentation/library-dto";
import {
  PASTE_MAX_EDGE,
  PASTE_MAX_PIXELS,
  PASTE_SEND_BYTES,
  blockedPasteMessage,
  clipboardProblem,
  fitWithin,
  followSave,
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

  it("Given 2MiB 이하지만 서버의 25 MP를 넘는 PNG When 계획하면 Then 줄여 보낸다", () => {
    expect(PASTE_MAX_PIXELS).toBe(pictureLimits.maxInputPixels);
    expect(uploadPlan(file("image/png", 500_000), { width: 6000, height: 4200 })).toBe("shrink");
    expect(uploadPlan(file("image/jpeg", 500_000), { width: 5001, height: 5000 })).toBe("shrink");
  });

  it("Given 서버의 25 MP 안인 작은 JPEG When 계획하면 Then 그대로 보낸다", () => {
    expect(uploadPlan(file("image/jpeg", 500_000), { width: 5000, height: 5000 })).toBe("send");
    expect(uploadPlan(file("image/jpeg", 500_000), { width: 4032, height: 3024 })).toBe("send");
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

describe("저장한 뒤의 미리보기", () => {
  const preview = { url: "blob:preview" };
  const idle = { preview, sending: false };

  it("Given 미리보기 When 저장이 시작되면 Then 미리보기를 두고 보내는 중으로 둔다", () => {
    expect(followSave(idle, { saving: true, saved: false })).toEqual({ preview, sending: true });
  });

  it("Given 보내는 중 When 다른 곳의 수집·확인으로 상품 사진이 바뀌어 다시 그려도 Then 미리보기와 보내는 중이 그대로다", () => {
    const sending = { preview, sending: true };
    expect(followSave(sending, { saving: true, saved: false })).toBe(sending);
  });

  it("Given 보내는 중 When 저장이 성공하면 Then 미리보기를 버린다", () => {
    expect(followSave({ preview, sending: true }, { saving: false, saved: true })).toEqual({ preview: null, sending: false });
  });

  it("Given 보내는 중 When 저장이 실패하면 Then 다시 저장할 수 있게 미리보기를 남긴다", () => {
    expect(followSave({ preview, sending: true }, { saving: false, saved: false })).toEqual({ preview, sending: false });
  });

  it("Given 저장한 적 없는 미리보기 When 다른 저장 문구가 보여도 Then 그대로다", () => {
    expect(followSave(idle, { saving: false, saved: true })).toBe(idle);
  });
});

describe("막힌 붙여넣기", () => {
  it("다른 저장이 끝나기를 기다리라고 알린다", () => {
    expect(blockedPasteMessage).toBe("다른 저장이 끝난 뒤 다시 붙여 넣어 주세요.");
  });
});
