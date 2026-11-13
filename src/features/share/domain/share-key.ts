// The Shortcut's key: a fixed prefix, so secret scanners and the database's format check recognise it, then 256 random
// bits in base64url. The database makes it and keeps only its SHA-256.
export const SHARE_SECRET_PATTERN = /^moti_sk_[A-Za-z0-9_-]{43}$/;

export type ShareSecret = string & { readonly __shareSecret: unique symbol };
export type ShareKeyId = string & { readonly __shareKeyId: unique symbol };
// What the owner sees of a key: never the secret, only its last four characters.
export type ShareKey = {
  id: ShareKeyId;
  hint: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};

export function parseShareSecret(value: unknown): ShareSecret | null {
  return typeof value === "string" && SHARE_SECRET_PATTERN.test(value) ? (value as ShareSecret) : null;
}

// One `Bearer <key>` credential and nothing else. Repeated headers arrive comma-joined and are refused.
export function readShareSecret(authorization: string | null): ShareSecret | null {
  const match = authorization === null ? null : /^Bearer ([^\s,]+)$/i.exec(authorization);
  return match ? parseShareSecret(match[1]) : null;
}

export type ShareErrorCode = "key_rejected" | "key_busy" | "invalid_input" | "identity_conflict" | "storage_unavailable";

export class ShareError extends Error {
  constructor(readonly code: ShareErrorCode, message: string) {
    super(message);
    this.name = "ShareError";
  }
}
