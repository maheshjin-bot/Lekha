/**
 * Postgres access for the database suites.
 *
 * Connection comes from LEKHA_TEST_DATABASE_URL — deliberately not the generic
 * DATABASE_URL, so that a variable already exported for some other purpose
 * cannot silently aim this suite at a database nobody meant to touch.
 *
 *   LEKHA_TEST_DATABASE_URL=postgresql://... npm run test
 *
 * Two levels of access, because they carry very different risk:
 *
 *   read-only   any database. The invariant queries only SELECT, so pointing
 *               this at the live project is safe and is in fact the point —
 *               "does production still balance" is the assertion that matters.
 *
 *   writes      gated behind LEKHA_TEST_ALLOW_WRITES=1 as well. Trigger and
 *               RLS-negative tests need fixtures, so they need a seeded branch
 *               or local database, never the live one. Every write runs inside
 *               `inRollback`, but a rollback is not a defence against a
 *               constraint-violating trigger test running on real data.
 */
import type { Client, Pool } from "pg";

export const connectionString = process.env.LEKHA_TEST_DATABASE_URL ?? "";
export const hasDb = connectionString.length > 0;
export const allowWrites = hasDb && process.env.LEKHA_TEST_ALLOW_WRITES === "1";

/** Reason a suite skipped, so the skip is self-explaining in the report. */
export const noDbReason =
  "LEKHA_TEST_DATABASE_URL is not set — database suite not executed";

let pool: Pool | null = null;

async function getPool(): Promise<Pool> {
  if (pool) return pool;
  const pg = await import("pg");
  pool = new pg.default.Pool({
    connectionString,
    max: 4,
    // Supabase's pooler terminates idle sessions; fail fast rather than hang
    // the whole run behind a dead socket.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 1_000,
  });
  return pool;
}

/** One-shot query. Returns rows only — nothing here needs the command tag. */
export async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const p = await getPool();
  const res = await p.query(text, params);
  return res.rows as T[];
}

/** Convenience for the many assertions that are "this count must be zero". */
export async function count(text: string, params: unknown[] = []): Promise<number> {
  const rows = await sql<{ n: string }>(text, params);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Runs `fn` inside a transaction that is always rolled back, even when the
 * assertion inside it throws. Fixtures never outlive the test.
 */
export async function inRollback<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const p = await getPool();
  const client = (await p.connect()) as unknown as Client;
  try {
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => {});
    (client as unknown as { release: () => void }).release();
  }
}

/**
 * Impersonates an authenticated user the way PostgREST does, so policies
 * written against auth.uid() are actually exercised rather than inspected.
 * Must be called inside `inRollback` — `set local` is transaction-scoped.
 */
export async function asUser(client: Client, userId: string | null): Promise<void> {
  await client.query("set local role authenticated");
  await client.query("select set_config('request.jwt.claims', $1, true)", [
    JSON.stringify({ sub: userId, role: "authenticated" }),
  ]);
}

/** Drops back to the owning role, which is not subject to the policies. */
export async function asOwner(client: Client): Promise<void> {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', null, true)");
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
}
