import { NextRequest, NextResponse } from "next/server";
import { sequencesCaller } from "@/lib/apiAuth";
import { listFacts, setFact, SequenceError } from "@/lib/sequences";

// Shared, round-level facts that step bodies reference as {{key}} tokens.
// GET lists them; PATCH { key, value } updates one. Keys are fixed by
// migration 0011: facts are a small, deliberate vocabulary, not a K/V store.
export async function GET(req: NextRequest) {
  const caller = await sequencesCaller(req);
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ facts: await listFacts() });
}

export async function PATCH(req: NextRequest) {
  const caller = await sequencesCaller(req);
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (
    !body ||
    typeof body.key !== "string" ||
    !body.key.trim() ||
    typeof body.value !== "string"
  ) {
    return NextResponse.json(
      { error: "key and value are required" },
      { status: 400 },
    );
  }
  try {
    // fact changes are global, so there is no sequence log to attach to
    const fact = await setFact(body.key.trim(), body.value);
    return NextResponse.json(fact);
  } catch (e) {
    const status = e instanceof SequenceError ? e.status : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "update failed" },
      { status },
    );
  }
}
