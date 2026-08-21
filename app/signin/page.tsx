import { signIn } from "@/auth";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; callbackUrl?: string }>;
}) {
  const params = await searchParams;
  return (
    <div className="signin-wrap">
      <div className="signin-card">
        <h1>
          Rebel One <span style={{ color: "var(--accent)" }}>Sequences</span>
        </h1>
        <p>Sign in with your rbl1.com Google account.</p>
        <form
          action={async () => {
            "use server";
            await signIn("google", {
              redirectTo: params.callbackUrl ?? "/",
            });
          }}
        >
          <button type="submit" className="google-btn">
            Continue with Google
          </button>
        </form>
      </div>
      {params.error === "AccessDenied" && (
        <div className="signin-error">
          That Google account is not on the allowlist. Sign in as
          sergio@rbl1.com.
        </div>
      )}
      {params.error && params.error !== "AccessDenied" && (
        <div className="signin-error">Sign-in failed: {params.error}</div>
      )}
    </div>
  );
}
