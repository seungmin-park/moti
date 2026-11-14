import { cookies } from "next/headers";
import { after } from "next/server";
import { decideAccess } from "@/features/auth/domain/access";
import {
  createAccessTokenClient,
  createSupabaseServerClient,
  exchangeCode,
  readAccessToken,
  readAuthConfig,
  readGoogleSession,
  signOut,
  startGoogleLogin,
  type AuthConfig,
} from "@/features/auth/infrastructure/supabase-auth";
import type { AuthRequestContext } from "@/features/auth/presentation/auth-handlers";
import type { LibraryRestoreResult } from "@/features/library/application/commands";
import { createLibraryService } from "@/features/library/application/library-service";
import { sweepPictures } from "@/features/library/application/picture-sweep";
import { followUpRestore } from "@/features/library/application/restore-follow-up";
import { createPictureOrphanStore, createPictureStore } from "@/features/library/infrastructure/product-pictures";
import { createSupabaseLibraryStore } from "@/features/library/infrastructure/supabase-library-store";
import type { LibraryRequestContext } from "@/features/library/presentation/library-handlers";
import { createShareKeyService } from "@/features/share/application/share-service";
import { createSupabaseShareKeyStore } from "@/features/share/infrastructure/supabase-share-store";
import { createWorkerKeyService } from "@/features/worker/application/worker-service";
import { createSupabaseWorkerKeyStore } from "@/features/worker/infrastructure/supabase-worker-store";
import { createCollectionRunner, runWithin, type CollectionRequest } from "@/features/metadata/application/collection";
import { WAKE_CONCURRENCY, WAKE_WINDOW_MS } from "@/features/metadata/application/commands";
import { createPictureCopier } from "@/features/metadata/application/picture-copy";
import { strictFetchPolicy } from "@/features/metadata/infrastructure/address-policy";
import { readProductPage } from "@/features/metadata/infrastructure/html-reader";
import { createSafeImageSource, createSafePageSource } from "@/features/metadata/infrastructure/safe-fetch";
import { normalizePicture } from "@/features/metadata/infrastructure/sharp-normalizer";
import { createSupabaseCollectionStore } from "@/features/metadata/infrastructure/supabase-collection-store";

async function connect() {
  const config = readAuthConfig(process.env);
  if (!config) return null;
  const store = await cookies();
  return { config, client: createSupabaseServerClient(config, store) };
}

function unavailable(): never {
  throw new Error("Supabase 설정이 없습니다.");
}

// Cookie writes throw once the response is sent, so work after it never reuses the cookie client.
function afterResponseClient(config: AuthConfig, accessToken: string) {
  return createAccessTokenClient(config, accessToken, { requestTimeoutMs: 10_000 });
}

function collectionRunner(client: ReturnType<typeof afterResponseClient>) {
  return createCollectionRunner({
    store: createSupabaseCollectionStore(client),
    source: createSafePageSource({ policy: strictFetchPolicy }),
    read: readProductPage,
    copier: createPictureCopier({
      source: createSafeImageSource({ policy: strictFetchPolicy }),
      normalize: normalizePicture,
      pictures: createPictureStore(client),
    }),
  });
}

function scheduleCollection(config: AuthConfig, accessToken: string | null, request: CollectionRequest) {
  if (!accessToken) return;
  const runner = collectionRunner(afterResponseClient(config, accessToken));
  after(() => runner.run(request));
}

function scheduleCollections(config: AuthConfig, accessToken: string | null, requests: CollectionRequest[]) {
  if (!accessToken) return;
  const runner = collectionRunner(afterResponseClient(config, accessToken));
  after(() => runWithin(requests, runner.run, { concurrency: WAKE_CONCURRENCY, deadline: Date.now() + WAKE_WINDOW_MS, now: Date.now }));
}

// Alongside the woken collections and inside the same window: one round of two calls, each bounded like the rest.
function scheduleSweep(config: AuthConfig, accessToken: string | null) {
  if (!accessToken) return;
  const client = afterResponseClient(config, accessToken);
  after(() => sweepPictures({ orphans: createPictureOrphanStore(client), pictures: createPictureStore(client) }));
}

function scheduleRestoreFollowUp(config: AuthConfig, accessToken: string | null, result: LibraryRestoreResult) {
  if (!accessToken) return;
  const client = afterResponseClient(config, accessToken);
  const runner = collectionRunner(client);
  after(() => followUpRestore(result, { pictures: createPictureStore(client), collect: runner.run, now: Date.now }));
}

export async function libraryContext(): Promise<LibraryRequestContext> {
  const connection = await connect();
  if (!connection) {
    return {
      access: { kind: "unconfigured" },
      service: createLibraryService({
        snapshot: unavailable,
        saveLink: unavailable,
        createCollection: unavailable,
        openPicture: unavailable,
        changeProduct: unavailable,
        deleteProduct: unavailable,
        renameCollection: unavailable,
        exportLibrary: unavailable,
        restoreLibrary: unavailable,
      }),
      signOut: async () => {},
      collect: () => {},
      retry: unavailable,
      settleRestore: () => {},
      shareKeys: createShareKeyService({ read: unavailable, issue: unavailable, revoke: unavailable }),
      workerKeys: createWorkerKeyService({ read: unavailable, issue: unavailable, revoke: unavailable }),
      wake: unavailable,
      collectAll: () => {},
      sweep: () => {},
    };
  }
  const { config, client } = connection;
  const access = decideAccess(await readGoogleSession(client), config.ownerSubject);
  const accessToken = access.kind === "allowed" ? await readAccessToken(client) : null;
  return {
    access,
    service: createLibraryService(createSupabaseLibraryStore(client)),
    signOut: () => signOut(client),
    collect: (request) => scheduleCollection(config, accessToken, request),
    retry: (command) => createSupabaseCollectionStore(client).retry(command),
    settleRestore: (result) => scheduleRestoreFollowUp(config, accessToken, result),
    shareKeys: createShareKeyService(createSupabaseShareKeyStore(client)),
    workerKeys: createWorkerKeyService(createSupabaseWorkerKeyStore(client)),
    wake: (command) => createSupabaseCollectionStore(client).wake(command),
    collectAll: (requests) => scheduleCollections(config, accessToken, requests),
    sweep: () => scheduleSweep(config, accessToken),
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
