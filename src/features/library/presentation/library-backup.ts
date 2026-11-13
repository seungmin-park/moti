import { z } from "zod";
import { parseCollectionName } from "../../wishlist/collection-name";
import { parseLink } from "../../wishlist/link";
import {
  EARLIEST_PURCHASE_DATE,
  MAX_PAID_AMOUNT,
  PAID_CURRENCIES,
  parseProductNote,
  parseProductTitle,
} from "../../wishlist/product-fields";
import type { LibraryBackup } from "../domain/library";

// The one definition of the backup file. The screen checks a chosen file with it before asking to restore, and the
// restore route checks the same bytes again. It accepts only values the app itself would have stored (canonical
// links, names and memos), so a restore writes exactly what the file says. Time-relative rules (a purchase date after
// today) belong to the server's command, so a wrong phone clock never refuses a good file.
export const LIBRARY_BACKUP_FORMAT = "moti.library-backup";
export const LIBRARY_BACKUP_VERSION = 1;
// Under the 4.5 MB request body limit of the hosting functions.
export const MAX_BACKUP_BYTES = 4 * 1024 * 1024;
export const MAX_BACKUP_PRODUCTS = 5000;
export const MAX_BACKUP_COLLECTIONS = 500;
const MAX_MEMBERSHIPS = 100;

const timestamp = z.iso.datetime({ precision: 3 });
function isStoredTitle(value: string): boolean {
  const parsed = parseProductTitle(value);
  return parsed.ok && parsed.value === value;
}
function isStoredCollectionName(value: string): boolean {
  const parsed = parseCollectionName(value);
  return parsed.ok && parsed.name === value;
}
const title = z.string().refine(isStoredTitle, "앱이 저장하는 이름이 아니에요.");
const collectionName = z.string().refine(isStoredCollectionName, "앱이 저장하는 컬렉션 이름이 아니에요.");
const purchaseDate = z.iso.date().refine((value) => value >= EARLIEST_PURCHASE_DATE, "1900-01-01 이후 날짜가 아니에요.");
const paidPrice = z.object({
  amountMinor: z.number().int().min(0).max(MAX_PAID_AMOUNT),
  currency: z.string().refine((value) => (PAID_CURRENCIES as readonly string[]).includes(value), "원화가 아니에요."),
}).strict();

const backupCollectionSchema = z.object({ name: collectionName, createdAt: timestamp }).strict();

const backupProductSchema = z.object({
  sourceUrl: z.string(),
  option: z.string(),
  collectedTitle: title,
  ownerTitle: title.nullable(),
  note: z.string().refine((value) => parseProductNote(value).ok, "저장할 수 없는 메모예요."),
  collections: z.array(z.string()).max(MAX_MEMBERSHIPS),
  addedAt: timestamp,
  purchase: z.discriminatedUnion("status", [
    z.object({ status: z.literal("wish") }).strict(),
    z.object({ status: z.literal("purchased"), date: purchaseDate.nullable(), price: paidPrice.nullable() }).strict(),
  ]),
  lastSuccessfulPrice: z.object({
    amountMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Z]{3}$/),
    checkedAt: timestamp,
  }).strict().nullable(),
}).strict().superRefine((product, context) => {
  const parsed = parseLink(product.sourceUrl, product.option);
  if (!parsed.ok) {
    context.addIssue({ code: "custom", path: [parsed.field === "url" ? "sourceUrl" : "option"], message: parsed.message });
    return;
  }
  if (parsed.link.sourceUrl !== product.sourceUrl) {
    context.addIssue({ code: "custom", path: ["sourceUrl"], message: "앱이 저장하는 링크가 아니에요." });
  }
  if (parsed.link.option !== product.option) {
    context.addIssue({ code: "custom", path: ["option"], message: "앱이 저장하는 옵션이 아니에요." });
  }
});

// Collection names are unique per owner ignoring case, a product is filed into names the file defines, once each,
// and two products never share a link identity.
export const libraryBackupSchema = z.object({
  format: z.literal(LIBRARY_BACKUP_FORMAT),
  version: z.literal(LIBRARY_BACKUP_VERSION),
  exportedAt: timestamp,
  collections: z.array(backupCollectionSchema).max(MAX_BACKUP_COLLECTIONS),
  products: z.array(backupProductSchema).max(MAX_BACKUP_PRODUCTS),
}).strict().superRefine((file, context) => {
  const keys = new Set<string>();
  file.collections.forEach(({ name }, index) => {
    const key = name.toLowerCase();
    if (keys.has(key)) context.addIssue({ code: "custom", path: ["collections", index, "name"], message: "같은 컬렉션 이름이 있어요." });
    keys.add(key);
  });
  const names = new Set(file.collections.map(({ name }) => name));
  const identities = new Set<string>();
  file.products.forEach((product, index) => {
    const filed = new Set<string>();
    product.collections.forEach((name, position) => {
      if (!names.has(name) || filed.has(name)) {
        context.addIssue({ code: "custom", path: ["products", index, "collections", position], message: "컬렉션 소속을 확인할 수 없어요." });
      }
      filed.add(name);
    });
    const parsed = parseLink(product.sourceUrl, product.option);
    if (!parsed.ok) return;
    const identity = JSON.stringify([parsed.link.identityUrl, parsed.link.option]);
    if (identities.has(identity)) context.addIssue({ code: "custom", path: ["products", index, "sourceUrl"], message: "같은 링크가 두 번 있어요." });
    identities.add(identity);
  });
});

export type LibraryBackupDocument = z.infer<typeof libraryBackupSchema>;
export type BackupCounts = { products: number; collections: number };
export type BackupProblem = "not_backup" | "newer_version" | "invalid";
export type BackupReading =
  | { ok: true; document: LibraryBackupDocument; counts: BackupCounts }
  | { ok: false; problem: BackupProblem; path: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function issuePath(issue: z.core.$ZodIssue): string | null {
  const path = issue.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]] : issue.path;
  return path.length === 0 ? null : path.map(String).join(".");
}

export function readLibraryBackup(value: unknown): BackupReading {
  if (!isRecord(value) || value.format !== LIBRARY_BACKUP_FORMAT) return { ok: false, problem: "not_backup", path: null };
  if (typeof value.version === "number" && Number.isInteger(value.version) && value.version > LIBRARY_BACKUP_VERSION) {
    return { ok: false, problem: "newer_version", path: "version" };
  }
  const result = libraryBackupSchema.safeParse(value);
  if (!result.success) return { ok: false, problem: "invalid", path: issuePath(result.error.issues[0]) };
  const document = result.data;
  return { ok: true, document, counts: { products: document.products.length, collections: document.collections.length } };
}

export function toLibraryBackupDocument(backup: LibraryBackup, exportedAt: Date): LibraryBackupDocument {
  return {
    format: LIBRARY_BACKUP_FORMAT,
    version: LIBRARY_BACKUP_VERSION,
    exportedAt: exportedAt.toISOString(),
    collections: backup.collections.map(({ name, createdAt }) => ({ name, createdAt })),
    products: backup.products.map((product) => ({
      sourceUrl: product.sourceUrl,
      option: product.option,
      collectedTitle: product.collectedTitle,
      ownerTitle: product.ownerTitle,
      note: product.note,
      collections: [...product.collectionNames],
      addedAt: product.addedAt,
      purchase: product.purchase.status === "wish"
        ? { status: "wish" }
        : { status: "purchased", date: product.purchase.date, price: product.purchase.price && { ...product.purchase.price } },
      lastSuccessfulPrice: product.lastSuccessfulPrice && { ...product.lastSuccessfulPrice },
    })),
  };
}

const seoulMinute = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function backupFileName(exportedAt: Date): string {
  const part = Object.fromEntries(seoulMinute.formatToParts(exportedAt).map(({ type, value }) => [type, value]));
  return `moti-backup-${part.year}${part.month}${part.day}-${part.hour}${part.minute}.json`;
}
