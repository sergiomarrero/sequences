import "server-only";
import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { auth } from "@/auth";

// Who is calling a sequences API route:
// - "user": Sergio, signed in through Google SSO (the web UI)
// - "sync": Claude's mailman run, authenticated by SEQUENCES_SYNC_TOKEN
//   (Authorization: Bearer <token>). The token is scoped to these routes
//   only; it is not the Supabase key.
export type SequencesCaller = "user" | "sync";

function tokenMatches(header: string | null): boolean {
  const token = process.env.SEQUENCES_SYNC_TOKEN;
  if (!token || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export async function sequencesCaller(
  req: NextRequest,
): Promise<SequencesCaller | null> {
  if (tokenMatches(req.headers.get("authorization"))) return "sync";
  const session = await auth();
  return session?.user ? "user" : null;
}
