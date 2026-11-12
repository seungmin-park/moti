import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAccessTokenClient } from "./supabase-auth";

let server: Server;
let url: string;

beforeAll(async () => {
  // Accepts every request and never answers, like a database or Storage call that hangs.
  server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("응답 뒤 작업용 Supabase 클라이언트", () => {
  it("Given 응답하지 않는 Supabase When RPC와 Storage를 부르면 Then 정한 시간 안에 오류로 끝난다", async () => {
    const client = createAccessTokenClient({ supabaseUrl: url, supabaseKey: "test-anon-key-000000", ownerSubject: undefined },
      "token", { requestTimeoutMs: 200 });
    const started = Date.now();

    const [rpc, upload] = await Promise.all([
      client.rpc("moti_snapshot"),
      client.storage.from("product-pictures").upload("a/b/c-1.webp", new Uint8Array([1]), { contentType: "image/webp" }),
    ]);

    expect(rpc.error).not.toBeNull();
    expect(upload.error).not.toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  }, 4000);
});
