import { NextRequest, NextResponse } from "next/server";
import { sequencesCaller } from "@/lib/apiAuth";
import { listNoSendDays } from "@/lib/sequences";
import { supabase } from "@/lib/supabase";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// The no-send calendar: dates the scheduled run must not send. Weekends
// are implicit; this list holds holidays and any day Sergio adds. It
// governs the schedule only: Send now and direct asks are exempt.
export async function GET(req: NextRequest) {
  const caller = await sequencesCaller(req);
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ no_send_days: await listNoSendDays() });
}

export async function POST(req: NextRequest) {
  const caller = await sequencesCaller(req);
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body.day !== "string" || !DAY_RE.test(body.day)) {
    return NextResponse.json({ error: "day must be YYYY-MM-DD" }, { status: 400 });
  }
  const label =
    typeof body.label === "string" ? body.label.trim().slice(0, 80) : "";
  const res = await supabase()
    .from("crm_no_send_days")
    .upsert({ day: body.day, label });
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const caller = await sequencesCaller(req);
  if (!caller) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  if (!body || typeof body.day !== "string" || !DAY_RE.test(body.day)) {
    return NextResponse.json({ error: "day must be YYYY-MM-DD" }, { status: 400 });
  }
  const res = await supabase()
    .from("crm_no_send_days")
    .delete()
    .eq("day", body.day);
  if (res.error) {
    return NextResponse.json({ error: res.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
