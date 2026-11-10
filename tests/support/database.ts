import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { readDatabaseConfig } from "./database-config";

type TestUser = { id: string; email: string; googleSubject: string; client: SupabaseClient };
export type DatabaseFixture = {
  owner: TestUser;
  stranger: TestUser;
  anonymous: SupabaseClient;
  admin: Pool;
  cleanup: () => Promise<void>;
  close: () => Promise<void>;
};

export async function createDatabaseFixture(): Promise<DatabaseFixture> {
  const config = readDatabaseConfig();
  const admin = new Pool({ connectionString: config.databaseUrl, max: 3, connectionTimeoutMillis: 5000 });
  const auth = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
  const administration = createClient(config.apiUrl, config.serviceRoleKey, { auth });
  const users: string[] = [];

  async function verifyRun() {
    const result = await admin.query<{ id: string }>("select id from moti_test.run");
    if (result.rows.length !== 1 || result.rows[0].id !== config.runId) {
      throw new Error("테스트가 소유한 DB가 아니므로 데이터에 접근하지 않습니다.");
    }
  }

  async function cleanup() {
    await verifyRun();
    await admin.query("delete from auth.users where id = any($1::uuid[])", [users]);
  }

  async function createUser(): Promise<TestUser> {
    const email = `moti-${randomUUID()}@example.test`;
    const password = `${randomUUID()}aA1!`;
    const created = await administration.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error || !created.data.user) throw new Error(created.error?.message || "테스트 사용자를 만들지 못했습니다.");
    const id = created.data.user.id;
    users.push(id);
    const googleSubject = `moti-test-${id}`;
    await admin.query(
      "insert into auth.identities (user_id, provider_id, provider, identity_data) values ($1, $2, 'google', $3::jsonb)",
      [id, googleSubject, JSON.stringify({ sub: googleSubject, email, email_verified: true })],
    );
    const client = createClient(config.apiUrl, config.anonKey, { auth });
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error || !signedIn.data.session) throw new Error(signedIn.error?.message || "테스트 사용자 인증에 실패했습니다.");
    return { id, email, googleSubject, client };
  }

  try {
    await verifyRun();
    const owner = await createUser();
    const stranger = await createUser();
    await admin.query("insert into moti.owner_config (owner_id, google_subject) values ($1, $2)", [owner.id, owner.googleSubject]);
    return {
      owner,
      stranger,
      anonymous: createClient(config.apiUrl, config.anonKey, { auth }),
      admin,
      cleanup,
      close: () => admin.end(),
    };
  } catch (error) {
    try { await cleanup(); } finally { await admin.end(); }
    throw error;
  }
}
