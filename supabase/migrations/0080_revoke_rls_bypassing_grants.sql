-- ============================================================================
-- 0080 — Take away the privileges row-level security cannot protect
-- ============================================================================
-- Found while checking the grants on a table added in 0079, then confirmed to
-- be project-wide: all 64 tables in `public` grant BOTH `anon` AND
-- `authenticated` the complete privilege set, and pg_default_acl hands the
-- same set to every table created in future. That is Supabase's stock
-- bootstrap (arwdDxtm), not a mistake anyone here made — but three of those
-- privileges are worth removing.
--
-- WHY TRUNCATE IS THE ONE THAT MATTERS. Every other data privilege here is
-- filtered by row-level security: SELECT, INSERT, UPDATE and DELETE all go
-- through the policies on each table, which is why granting them to `anon` is
-- how Supabase is designed to work. TRUNCATE is different -- PostgreSQL does
-- NOT apply row-level security to it. A role holding TRUNCATE can empty a
-- table outright no matter what its policies say. The audit log, the company
-- register and the API key table were all in that position.
--
-- HONEST SEVERITY, because it would be easy to overstate this. It is NOT
-- reachable through the exposed surface: PostgREST has no HTTP verb that emits
-- TRUNCATE, so the REST API can only ever issue the four DML statements that
-- RLS does filter. Exploiting it needs a direct PostgreSQL connection
-- authenticating as `anon` or `authenticated`, which requires the database
-- password rather than an API key. So this is defence in depth against a
-- second failure, not the closing of an open door.
--
-- TRIGGER and REFERENCES go too, for the same reason and with the same
-- caveat: neither is used by PostgREST or by any application code, and both
-- widen what a compromised role could do to the schema itself -- attach a
-- function to a table's writes, or pin a foreign key onto it that blocks
-- later cleanup. Nothing needs them, so nothing loses them.
--
-- DELIBERATELY LEFT ALONE: SELECT, INSERT, UPDATE and DELETE. Those ARE the
-- API surface, they are RLS-filtered, and revoking them from `anon` in
-- particular would be a change of a different kind -- the public API (0063)
-- runs through SECURITY DEFINER functions that verify their own key and never
-- touch anon's table privileges, but sign-in and other flows are not audited
-- here and this migration is not the place to find out the hard way.
--
-- Also updates the default privileges so a table added tomorrow does not
-- quietly reacquire all three.
--
-- ONE LIMIT, STATED RATHER THAN GLOSSED. pg_default_acl holds a SECOND entry
-- for schema public, owned by `supabase_admin`, which still grants the full
-- set. It cannot be changed from here: `postgres` is not a superuser on
-- Supabase, and altering another role's default privileges is refused outright
-- ("permission denied to change default privileges" — confirmed by trying).
-- That entry governs only tables created BY supabase_admin, i.e. platform
-- internals; every table in this application is created by a migration running
-- as postgres, which the entry updated below does govern. So the practical
-- protection holds, and the accompanying test is scoped to the postgres
-- grantor rather than asserting something nobody here is able to fix.
-- ============================================================================

revoke truncate, trigger, references
  on all tables in schema public
  from anon, authenticated;

alter default privileges in schema public
  revoke truncate, trigger, references on tables
  from anon, authenticated;
