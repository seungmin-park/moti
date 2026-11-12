import { describe, expect, it } from "vitest";
import { sniffImageFormat } from "./picture";

const bytes = (...parts: (string | number[])[]) =>
  Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? [...Buffer.from(part, "latin1")] : part)));
const box = (type: string, payload: string) => {
  const size = 8 + payload.length;
  return bytes([size >>> 24, (size >>> 16) & 255, (size >>> 8) & 255, size & 255], type, payload);
};

describe("사진 형식 판별", () => {
  it.each<[string, Uint8Array, string]>([
    ["JPEG", bytes([0xff, 0xd8, 0xff, 0xe0], "JFIF"), "jpeg"],
    ["PNG", bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], "IHDR"), "png"],
    ["GIF87a", bytes("GIF87a", [1, 0, 1, 0]), "gif"],
    ["GIF89a", bytes("GIF89a", [1, 0, 1, 0]), "gif"],
    ["WebP", bytes("RIFF", [26, 0, 0, 0], "WEBPVP8L"), "webp"],
    ["AVIF", box("ftyp", "avif\0\0\0\0mif1miaf"), "avif"],
    ["AVIF 시퀀스", box("ftyp", "avis\0\0\0\0msf1avif"), "avif"],
    ["호환 브랜드에 AVIF가 있는 HEIF", box("ftyp", "mif1\0\0\0\0avifmiaf"), "avif"],
  ])("Given %s의 첫 바이트 When 판별하면 Then 형식을 안다", (_, head, format) => {
    expect(sniffImageFormat(head)).toBe(format);
  });

  it.each<[string, Uint8Array]>([
    ["SVG", bytes('<svg xmlns="http://www.w3.org/2000/svg">')],
    ["XML 선언으로 시작하는 SVG", bytes('<?xml version="1.0"?><svg>')],
    ["BOM 뒤의 SVG", bytes([0xef, 0xbb, 0xbf], "<svg>")],
    ["HTML", bytes("<!doctype html><html>")],
    ["HEIC", box("ftyp", "heic\0\0\0\0mif1heic")],
    ["브랜드만 비슷한 상자", box("ftyp", "avi\0\0\0\0\0mif1")],
    ["TIFF", bytes([0x49, 0x49, 0x2a, 0x00])],
    ["BMP", bytes("BM", [0, 0, 0, 0])],
    ["ICO", bytes([0, 0, 1, 0, 1, 0])],
    ["WEBP가 없는 RIFF", bytes("RIFF", [26, 0, 0, 0], "WAVEfmt ")],
    ["빈 입력", bytes()],
    ["잘린 PNG", bytes([0x89, 0x50, 0x4e])],
    ["잘린 ftyp", bytes([0, 0, 0, 24], "ftypav")],
    ["크기가 거짓인 ftyp", bytes([0, 0, 0, 4], "ftypavif")],
  ])("Given %s When 판별하면 Then 사진으로 받지 않는다", (_, head) => {
    expect(sniffImageFormat(head)).toBeNull();
  });
});
