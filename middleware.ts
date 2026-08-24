import { NextResponse } from "next/server";
import { auth } from "@/auth";

// Local E2E only: lets Playwright render the page without a Google session.
// Double-gated so it cannot exist in production: the var must be set
// explicitly at process start AND the process must not be running on Vercel
// (Vercel always sets VERCEL=1).
const e2e = process.env.SEQUENCES_E2E === "1" && !process.env.VERCEL;

export default e2e ? () => NextResponse.next() : auth;

// Everything requires a session except the auth endpoints, the sign-in page,
// static assets, and the sequences API. The sequences API is excluded here
// because Claude's mailman calls it with a bearer token and no cookie; the
// route handlers do their own auth (session OR token) in lib/apiAuth.ts, so
// nothing is exposed by skipping the middleware.
export const config = {
  matcher: [
    "/((?!api/auth|api/sequences|signin|_next/static|_next/image|favicon.ico|robots.txt).*)",
  ],
};
