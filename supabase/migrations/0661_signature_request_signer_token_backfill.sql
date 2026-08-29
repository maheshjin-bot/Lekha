-- Backfill: mint an access_token for a signer whose request was already
-- 'sent' or 'completed' before migration 0575 introduced the token column.
--
-- 0575's own send_signature_request only mints a token at the moment a
-- draft transitions to sent — correct for every request created from here
-- on, but it leaves a real gap for anything already sent earlier in this
-- session (found live during the batch-11 integration pass: 3 real signers
-- on request 2e337648-cc82-4004-9bc9-5104a53edd51, LEKHA's own "Live E2E
-- test — Godown lease renewal" data from 0175's original shipping report,
-- created before 0575 landed). Without this, those signers have no way to
-- reach the new external-signer link at all.
--
-- Same token shape 0575's own UPDATE uses (encode(gen_random_bytes(32),
-- 'hex')), applied once, only to a signer that (a) genuinely has no token
-- yet and (b) belongs to a request that is no longer a draft — a still-draft
-- request correctly has no token minted yet, and this must not change that.
update public.signature_request_signers s
   set access_token = encode(extensions.gen_random_bytes(32), 'hex')
  from public.signature_requests r
 where r.id = s.request_id
   and s.access_token is null
   and r.status in ('sent', 'completed');
