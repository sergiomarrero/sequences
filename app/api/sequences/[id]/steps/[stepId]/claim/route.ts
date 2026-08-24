import { NextRequest, NextResponse } from "next/server";
import { sequencesCaller } from "@/lib/apiAuth";
import { claimStepSend, logEvent, releaseStepClaim } from "@/lib/sequences";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The mailman must win a claim here before it puts anything in front of an
// investor, and must send within the claim's staleness window.
//
// POST            -> 200 when the claim is yours, 409 when it is not.
// POST {release}  -> hand it back after a send that did not happen.
//
// Sync-only on purpose: this guards outbound mail, and the UI never sends.
// A 409 is the normal, healthy answer to a duplicate run, not an error.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; stepId: string }> },
) {
  const caller = await sequencesCaller(req);
  if (caller !== "sync") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { id, stepId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(stepId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);

  try {
    if (body && body.release === true) {
      await releaseStepClaim(id, stepId);
      return NextResponse.json({ ok: true, released: true });
    }
    const won = await claimStepSend(id, stepId);
    if (!won) {
      await logEvent(id, {
        actor: "sync",
        action: "note",
        detail:
          "send claim refused: this step is already claimed by another run, or already sent. No email was sent.",
      });
      return NextResponse.json(
        {
          error:
            "already claimed or already sent; another run owns this send",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: true, claimed: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "claim failed" },
      { status: 500 },
    );
  }
}
