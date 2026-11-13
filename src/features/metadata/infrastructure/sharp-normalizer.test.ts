import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { pictureLimits } from "../domain/picture";
import { createPictureNormalizer, normalizePicture } from "./sharp-normalizer";

const solid = (width: number, height: number, background: string) =>
  sharp({ create: { width, height, channels: 3, background } });

// Left half red, right half blue: after an orientation fix the colours say which way the picture turned.
const halves = (width: number, height: number) => solid(width, height, "#ff0000")
  .composite([{ input: { create: { width: width / 2, height, channels: 3, background: "#0000ff" } }, left: width / 2, top: 0 }]);

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// A tiny file whose header claims 30000×30000 pixels.
function pixelBomb(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(30_000, 0);
  header.writeUInt32BE(30_000, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.alloc(1000))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

async function normalized(bytes: Buffer, format: Parameters<typeof normalizePicture>[1]) {
  const result = await normalizePicture(bytes, format);
  if (!result.ok) throw new Error(`정규화하지 못했습니다: ${result.code}`);
  return { ...result.picture, metadata: await sharp(result.picture.bytes).metadata() };
}

async function pixel(bytes: Uint8Array, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [...data.subarray(at, at + 3)];
}

describe("사진 정규화", () => {
  it("Given 회전 정보와 EXIF가 든 JPEG When 정규화하면 Then 바로 세운 WebP이고 메타데이터는 남지 않는다", async () => {
    const jpeg = await halves(300, 200).jpeg().withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Artist: "moti-test", Copyright: "owner" } }).toBuffer();

    const picture = await normalized(jpeg, "jpeg");

    expect(picture.metadata).toMatchObject({ format: "webp", width: 200, height: 300 });
    expect({ width: picture.width, height: picture.height }).toEqual({ width: 200, height: 300 });
    expect(picture.metadata.orientation).toBeUndefined();
    expect(picture.metadata.exif).toBeUndefined();
    expect(picture.metadata.icc).toBeUndefined();
    expect(picture.metadata.xmp).toBeUndefined();
    expect(Buffer.from(picture.bytes).includes("moti-test")).toBe(false);
    const [top, bottom] = [await pixel(picture.bytes, 100, 10), await pixel(picture.bytes, 100, 290)];
    expect(top[0]).toBeGreaterThan(200);
    expect(bottom[2]).toBeGreaterThan(200);
  });

  it("Given 4000×3000 사진 When 정규화하면 Then 긴 변이 1200을 넘지 않고 작은 사진은 키우지 않는다", async () => {
    const large = await normalized(await solid(4000, 3000, "#336699").png().toBuffer(), "png");
    expect([large.width, large.height]).toEqual([1200, 900]);
    const small = await normalized(await solid(300, 200, "#336699").png().toBuffer(), "png");
    expect([small.width, small.height]).toEqual([300, 200]);
  });

  it("Given 뒤에 HTML을 붙인 PNG When 정규화하면 Then 픽셀만 다시 인코딩해 덧붙인 내용이 없다", async () => {
    const polyglot = Buffer.concat([await solid(30, 30, "#00ff00").png().toBuffer(), Buffer.from("<html><script>alert(1)</script></html>")]);
    const picture = await normalized(polyglot, "png");
    expect(picture.metadata.format).toBe("webp");
    expect(Buffer.from(picture.bytes).includes("<script")).toBe(false);
  });

  it("Given 움직이는 GIF When 정규화하면 Then 첫 장면 하나만 남는다", async () => {
    const frames = await Promise.all(["#ff0000", "#00ff00", "#0000ff"].map((colour) => solid(20, 20, colour).png().toBuffer()));
    const gif = await sharp(frames, { join: { animated: true } }).gif().toBuffer();
    expect((await sharp(gif).metadata()).pages).toBe(3);

    const picture = await normalized(gif, "gif");

    expect(picture.metadata).toMatchObject({ format: "webp", width: 20, height: 20 });
    expect(picture.metadata.pages).toBeUndefined();
    expect((await pixel(picture.bytes, 10, 10))[0]).toBeGreaterThan(200);
  });

  it.each<["webp" | "avif", () => Promise<Buffer>]>([
    ["webp", () => solid(64, 48, "#123456").webp().toBuffer()],
    ["avif", () => solid(64, 48, "#123456").avif().toBuffer()],
  ])("Given %s 사진 When 정규화하면 Then WebP로 다시 만든다", async (format, make) => {
    expect((await normalized(await make(), format)).metadata).toMatchObject({ format: "webp", width: 64, height: 48 });
  });

  it("Given 판별한 형식과 내용이 다른 파일 When 정규화하면 Then 읽을 수 없는 사진이다", async () => {
    expect(await normalizePicture(await solid(30, 30, "#00ff00").png().toBuffer(), "jpeg"))
      .toEqual({ ok: false, code: "unreadable_image" });
  });

  it("Given 중간에 잘린 JPEG When 정규화하면 Then 읽을 수 없는 사진이다", async () => {
    const jpeg = await solid(400, 300, "#808080").jpeg().toBuffer();
    expect(await normalizePicture(jpeg.subarray(0, jpeg.length / 2), "jpeg")).toEqual({ ok: false, code: "unreadable_image" });
  });

  it("Given 머리말만 3만×3만 픽셀인 PNG When 정규화하면 Then 풀지 않고 너무 크다", async () => {
    expect(await normalizePicture(pixelBomb(), "png")).toEqual({ ok: false, code: "too_large" });
  });

  it("Given 시간 제한 안에 끝나지 않는 처리 When 정규화하면 Then 시간 초과로 끝낸다", async () => {
    const png = await solid(30, 30, "#808080").png().toBuffer();
    // A real overrun depends on the machine's speed, so libvips's timeout error is injected where sharp raises it.
    const limit = vi.spyOn(sharp.prototype, "timeout");
    const encode = vi.spyOn(sharp.prototype, "toBuffer").mockRejectedValueOnce(new Error('timeout: 2% complete\nVipsImage: killed for image "temp-60"'));
    try {
      expect(await normalizePicture(png, "png")).toEqual({ ok: false, code: "timeout" });
      expect(limit).toHaveBeenCalledExactlyOnceWith({ seconds: pictureLimits.maxNormalizeSeconds });
      expect(encode).toHaveBeenCalledOnce();
    } finally {
      limit.mockRestore();
      encode.mockRestore();
    }
  });

  it("Given 저장 한도보다 큰 결과 When 정규화하면 Then 너무 크다", async () => {
    const noise = Buffer.alloc(200 * 200 * 3);
    for (let index = 0; index < noise.length; index += 1) noise[index] = (index * 7919) % 251;
    const png = await sharp(noise, { raw: { width: 200, height: 200, channels: 3 } }).png().toBuffer();
    const tight = createPictureNormalizer({ ...pictureLimits, maxStoredBytes: 1024 });
    expect(await tight(png, "png")).toEqual({ ok: false, code: "too_large" });
  });
});
