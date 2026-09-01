-- Make the ambiguity message something a preparer can actually act on.
--
-- 1200 introduced app_private.ledger_for_role and had it refuse, rather than
-- guess, when a company has two ledgers in the same role. Refusing is right.
-- The wording was not:
--
--   'This company has more than one stock ledger (Stock in Hand,
--    Stock-in-Hand). Merge or rename them so exactly one remains...'
--
-- Renaming does nothing. The whole point of 1200 is that the name is no
-- longer the key, so renaming a duplicate leaves two ledgers in the role and
-- the same refusal. The advice was left over from the thinking the migration
-- itself replaced — and an error that names no achievable action is exactly
-- the failure the pilot criticised in the closing-stock screen, which
-- displayed the amount to post beside a button that refused to post it.
--
-- What a preparer can actually do is move the spare ledger to a different
-- group, or delete it if nothing was ever posted to it. So the message says
-- that, and says which one to keep: the one carrying the bookkeeping. Working
-- that out here is worth the extra query, because the person reading this has
-- two similarly-named ledgers in front of them and no other way to tell which
-- is which.
--
-- Nothing else about the resolver changes.

create or replace function app_private.ledger_for_role(p_company_id uuid, p_role text)
returns uuid
language plpgsql
stable
security definer
set search_path to ''
as $fn$
declare
  v_ids uuid[];
  v_detail text;
  v_keep text;
begin
  select array_agg(l.id order by l.name) into v_ids
    from public.ledgers l
    join public.account_groups g on g.id = l.group_id
   where l.company_id = p_company_id
     and coalesce(l.ledger_role, g.ledger_role) = p_role;

  if v_ids is null or cardinality(v_ids) = 0 then
    return null;
  end if;

  if cardinality(v_ids) > 1 then
    -- Describe each one by what it actually holds, so the choice is obvious.
    select string_agg(
             d.name || ' (' ||
             case
               when d.entries > 0 and d.opening <> 0
                 then d.entries || ' entr' || case when d.entries = 1 then 'y' else 'ies' end
                      || ', opening ' || to_char(d.opening, 'FM9999999990.00')
               when d.entries > 0
                 then d.entries || ' entr' || case when d.entries = 1 then 'y' else 'ies' end
               when d.opening <> 0 then 'opening ' || to_char(d.opening, 'FM9999999990.00')
               else 'empty'
             end || ')',
             '; ' order by d.entries desc, d.opening desc, d.name)
      into v_detail
      from (
        select l.name,
               coalesce(l.opening_balance_amount, 0) as opening,
               (select count(*) from public.voucher_entries ve
                 join public.vouchers v on v.id = ve.voucher_id and not v.is_deleted
                where ve.ledger_id = l.id) as entries
          from public.ledgers l
         where l.id = any(v_ids)
      ) d;

    select d.name into v_keep
      from (
        select l.name,
               coalesce(l.opening_balance_amount, 0) as opening,
               (select count(*) from public.voucher_entries ve
                 join public.vouchers v on v.id = ve.voucher_id and not v.is_deleted
                where ve.ledger_id = l.id) as entries
          from public.ledgers l
         where l.id = any(v_ids)
      ) d
     order by d.entries desc, d.opening desc, d.name
     limit 1;

    raise exception
      'This company has % ledgers acting as %: %. Keep "%" — it holds the bookkeeping — and move the other to a different account group, or delete it if it is empty.',
      cardinality(v_ids), replace(p_role, '_', ' '), v_detail, v_keep
      using errcode = '23505';
  end if;

  return v_ids[1];
end;
$fn$;

revoke all on function app_private.ledger_for_role(uuid, text) from public, anon;
grant execute on function app_private.ledger_for_role(uuid, text) to authenticated;

comment on function app_private.ledger_for_role(uuid, text) is
  'The single ledger carrying an effective ledger_role, coalesce(ledger, group). Null when absent, raises when ambiguous — naming what each duplicate holds and which to keep (1200, message 1220). The binding key for every close posting: never match a ledger by its English name.';
