export { auth as middleware } from "@/auth";

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
