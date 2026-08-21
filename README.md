# Rebel One Sequences

Standalone Sequence Desk: investor outreach sequences for Rebel One
Venture Studios. An introduction email starts the thread on approval;
up to seven follow-ups reply on the same thread after configurable
business-day waits. A reply from the investor stops their sequence.

This is the same Sequence Desk that ships inside the crm repo
(sergiomarrero/crm, page /sequences), extracted as its own deployable
app. Both apps point at the same Supabase tables (crm_sequences,
crm_sequence_steps, crm_sequence_templates), so a sequence edited in
one appears in the other. Deploy whichever you prefer; they do not
conflict.

## How it works

- **This app** is the editor and source of truth: draft, review, edit,
  approve, reorder, stop, "send next now". Everything autosaves.
- **Claude's daily run (the mailman)** reads `/api/sequences` with a
  bearer token each weekday, sends approved and due emails from
  Sergio's Gmail, and writes results back (thread ids, sent stamps,
  reply detection, holds).
- **Failsafe**: any `[bracketed]` slot left in a step blocks that send;
  the sequence goes to "held" with the reason shown at the top of the
  page until the slot is filled in.

## Setup

1. **Database**: the tables already exist in the shared Supabase
   project (created by crm's `db/migrations/0009_crm_sequences.sql`).
   For a fresh database, run `db/migrations/0001_sequences.sql`.
2. **Google OAuth**: in Google Cloud Console, create (or reuse) an
   OAuth 2.0 client and add
   `https://<your-domain>/api/auth/callback/google` to its Authorized
   redirect URIs. Every domain you sign in from needs its own entry.
3. **Env vars** (see `.env.example`): Supabase URL and service-role
   key, AUTH_SECRET, Google client id/secret, SEQUENCES_SYNC_TOKEN.
4. **Deploy** on Vercel; then set `CRM_BASE_URL` (this deployment's
   URL) and `SEQUENCES_SYNC_TOKEN` in the Claude environment so the
   mailman can reach the API.

## Local dev

```
npm install
cp .env.example .env.local   # fill in values
npm run dev
```
