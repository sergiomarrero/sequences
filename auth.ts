import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

// Google SSO locked to an explicit allowlist (default: sergio@rbl1.com).
// No database sessions; JWT only.
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      authorization: {
        params: {
          // hint the account picker toward the rbl1.com Workspace account
          hd: "rbl1.com",
          prompt: "select_account",
        },
      },
    }),
  ],
  trustHost: true,
  pages: { signIn: "/signin" },
  callbacks: {
    signIn({ profile }) {
      const allowed = (process.env.ALLOWED_EMAILS ?? "sergio@rbl1.com")
        .toLowerCase()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const email = profile?.email?.toLowerCase();
      return !!email && allowed.includes(email);
    },
    authorized({ auth: session }) {
      return !!session?.user;
    },
  },
});
