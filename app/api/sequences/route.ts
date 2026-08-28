import { NextRequest, NextResponse } from "next/server";
import { sequencesCaller } from "@/lib/apiAuth";
import {
  createSequenceFromTemplate,
  listSequences,
  SequenceError,
} from "@/lib/sequences";

export async function GET(req: NextRequest) {
  const caller = await sequencesCaller(req);
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const slim = req.nextUrl.searchParams.get("slim") === "1";
    return NextResponse.json(await listSequences({ slim }));
  } catch (e) {
    // a refused action is the caller's problem, not a server fault
    const status = e instanceof SequenceError ? e.status : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "query failed" },
      { status },
    );
  }
}

export async function POST(req: NextRequest) {
  const caller = await sequencesCaller(req);
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (
    !body ||
    typeof body.name !== "string" ||
    !body.name.trim() ||
    typeof body.email !== "string" ||
    !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email.trim())
  ) {
    return NextResponse.json({ error: "name and a valid email are required" }, { status: 400 });
  }
  try {
    const seq = await createSequenceFromTemplate({
      name: body.name,
      email: body.email,
      firm: typeof body.firm === "string" ? body.firm : null,
      background: typeof body.background === "string" ? body.background : null,
      template_id:
        typeof body.template_id === "string" && body.template_id
          ? body.template_id
          : null,
    });
    return NextResponse.json(seq, { status: 201 });
  } catch (e) {
    const status = e instanceof SequenceError ? e.status : 500;
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "create failed" },
      { status },
    );
  }
}
