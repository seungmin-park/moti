export type GoogleSession = {
  userId: string;
  googleSubjects: readonly string[];
};

export type Access =
  | { kind: "allowed"; userId: string }
  | { kind: "signed_out" }
  | { kind: "forbidden" }
  | { kind: "unconfigured" };

export function decideAccess(session: GoogleSession | null, ownerSubject: string | undefined): Access {
  const owner = ownerSubject?.trim();
  if (!owner) return { kind: "unconfigured" };
  if (!session) return { kind: "signed_out" };
  return session.googleSubjects.includes(owner)
    ? { kind: "allowed", userId: session.userId }
    : { kind: "forbidden" };
}
