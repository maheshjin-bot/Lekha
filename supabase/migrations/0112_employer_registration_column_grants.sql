-- Closes a real, live gap flagged (but deliberately left unfixed) by 0111's
-- own header comment: 0044 locked public.companies down to an explicit
-- per-column SELECT/UPDATE allowlist for `authenticated` (so password_hash
-- could never be read or overwritten by a plain .from("companies") call),
-- and every migration that adds a new company-level column since then has
-- had to extend that allowlist itself — 0111 remembered to do this for
-- upi_vpa, but 0085 (employer statutory registrations) added
-- pf_establishment_code, esi_employer_code, lin and shops_establishment_reg
-- WITHOUT extending the grant lists. The result: EmployerRegistrationsForm
-- (components/companies/EmployerRegistrationsForm.tsx) and its page both
-- read and write these four columns via plain `.from("companies")` calls
-- that have been failing outright for every real authenticated user since
-- 0085 shipped — `select pf_establishment_code from companies ...` as the
-- actual admin user (not the sbq superuser role, which bypasses column
-- grants entirely and so never surfaced this) errors 42501 permission
-- denied for table companies. Confirmed live in a rolled-back transaction
-- as the real admin user on Sharma Textiles before writing this migration.
--
-- Discovered as a side effect of building company backup/export (this
-- session's actual assigned task): the export tried to read these same
-- four columns for completeness and hit the identical 42501. Fixing the
-- grant here is strictly additive (two GRANT statements, no new privilege
-- beyond what every other non-sensitive company column already has) and
-- unblocks both features at once rather than working around it by quietly
-- dropping these columns from the export.

grant select (pf_establishment_code, esi_employer_code, lin, shops_establishment_reg)
  on public.companies to authenticated;

grant update (pf_establishment_code, esi_employer_code, lin, shops_establishment_reg)
  on public.companies to authenticated;
