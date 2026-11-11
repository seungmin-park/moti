import { describe, expect, it } from "vitest";
import { databaseConfigSchema } from "../support/database-config";

const local = {
  runId: "00000000-0000-4000-8000-000000000001",
  apiUrl: "http://127.0.0.1:56321",
  appUrl: "http://127.0.0.1:3180/",
  databaseUrl: "postgresql://postgres:test-password@127.0.0.1:56322/postgres",
  anonKey: "local-anonymous-fixture-key",
  serviceRoleKey: "local-administrator-fixture-key",
};

describe("DB 테스트 연결 경계", () => {
  it("지정한 로컬 포트만 받는다", () => {
    expect(databaseConfigSchema.safeParse(local).success).toBe(true);
  });

  it.each([
    { apiUrl: "https://example.supabase.co" },
    { appUrl: "https://moti.example.com/" },
    { appUrl: "http://127.0.0.1:3100/" },
    { databaseUrl: "postgresql://postgres:test@db.example.supabase.co:5432/postgres" },
    { databaseUrl: "postgresql://postgres:test@127.0.0.1:5432/postgres" },
    { databaseUrl: `${local.databaseUrl}?host=remote.example` },
    { databaseUrl: "postgresql://postgres:test@127.0.0.1:56322/production" },
  ])("운영 주소·다른 DB·연결 덮어쓰기를 거절한다 %j", (changed) => {
    expect(databaseConfigSchema.safeParse({ ...local, ...changed }).success).toBe(false);
  });
});
