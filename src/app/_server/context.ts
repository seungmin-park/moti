import { cookies } from "next/headers";
import { decideAccess } from "@/features/auth/domain/access";
import {
  createSupabaseServerClient,
  exchangeCode,
  readAuthConfig,
  readGoogleSession,
  signOut,
  startGoogleLogin,
} from "@/features/auth/infrastructure/supabase-auth";
import type { AuthRequestContext } from "@/features/auth/presentation/auth-handlers";
import { createLibraryService } from "@/features/library/application/library-service";
import { createSupabaseLibraryStore } from "@/features/library/infrastructure/supabase-library-store";
import type { LibraryRequestContext } from "@/features/library/presentation/library-handlers";

async function connect() {
  const config = readAuthConfig(process.env);
  if (!config) return null;
  const store = await cookies();
  return { config, client: createSupabaseServerClient(config, store) };
}

function unavailable(): never {
  throw new Error("Supabase 설정이 없습니다.");
}

export async function libraryContext(): Promise<LibraryRequestContext> {
  const connection = await connect();
  if (!connection) {
    return {
      access: { kind: "unconfigured" },
      service: createLibraryService({ snapshot: unavailable, saveLink: unavailable, createCollection: unavailable }),
      signOut: async () => {},
    };
  }
  const { config, client } = connection;
  return {
    access: decideAccess(await readGoogleSession(client), config.ownerSubject),
    service: createLibraryService(createSupabaseLibraryStore(client)),
    signOut: () => signOut(client),
  };
}

export async function authContext(): Promise<AuthRequestContext> {
  const connection = await connect();
  if (!connection) {
    return { ownerSubject: undefined, startGoogleLogin: unavailable, exchangeCode: unavailable, signOut: async () => {} };
  }
  const { config, client } = connection;
  return {
    ownerSubject: config.ownerSubject,
    startGoogleLogin: (redirectTo) => startGoogleLogin(client, redirectTo),
    exchangeCode: (code) => exchangeCode(client, code),
    signOut: () => signOut(client),
  };
}
