-- ============================================================================
-- 1290 — Settings → Modules' own TCS description still advertised Sec
-- 206C(1H), which 0023/0146 already established is abolished and out of
-- scope for this app
-- ============================================================================
-- 0004_module_engine.sql seeded the TCS module's description as "206C,
-- including 1H and the 194Q precedence rule" — accurate at the time, before
-- 0023_tcs_sections.sql's own header researched and documented that Finance
-- Act 2025 abolished Sec 206C(1H) effective 1 April 2025, and 0146 built the
-- 27EQ report on that basis (no 1H tracking anywhere in this schema).
-- Nothing ever went back and corrected the description a user actually
-- sees on the module toggle, so it kept claiming coverage of a section the
-- app deliberately does not implement. Found live (wave 7, 1 Sep 2026).
-- ============================================================================

update public.ref_modules
   set description = 'Sec 206C specified goods and services (scrap, minerals, timber, vehicles) — 1H was abolished by Finance Act 2025 and is out of scope, see migration 0023'
 where code = 'tcs';
