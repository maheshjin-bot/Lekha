-- The two tax computations bind the depreciation ledger by name as well.
--
-- Found by 1200's own verification query rather than by reading the code: an
-- earlier sweep searched for 'Stock-in-Hand', 'Changes in Inventories' and
-- 'Accumulated Depreciation' but dropped the bare word 'Depreciation' from the
-- pattern because it matched too much prose. These two were in the part it
-- stopped seeing. Worth recording — the sweep that finds a class of bug is
-- only as good as the pattern, and the narrower pattern is the one that feels
-- safe to write.
--
-- Both do the same thing for the same reason: total the book depreciation
-- actually posted, to reconcile it against the tax register.
--
--   get_income_tax_computation      -> v_book_dep_posted, added back to book
--                                      profit to reach taxable income
--   get_deferred_tax_reconciliation -> v_cum_book_dep, the AS 22 timing
--                                      difference against tax WDV
--
-- Rename the Depreciation ledger — to Schedule III's own wording, say, which
-- is exactly what a careful preparer would do — and both silently total zero.
-- The income-tax computation then adds nothing back and understates taxable
-- income by the whole year's depreciation; the deferred-tax reconciliation
-- reports the entire tax WDV difference as a timing difference that appeared
-- from nowhere. Neither raises anything. Both are numbers that get filed.
--
-- Same fix as 1200: bind by role. Both are rewritten off their live bodies so
-- the surrounding arithmetic — which the pilot verified to the paisa — is not
-- disturbed, and both assert afterwards that the predicate actually moved.

do $mig$
declare
  v_fn text;
  v_def text;
  v_before text;
begin
  foreach v_fn in array array['get_income_tax_computation', 'get_deferred_tax_reconciliation'] loop
    select pg_get_functiondef(p.oid) into v_def
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn and p.prokind = 'f'
     limit 1;

    if v_def is null then
      raise exception '1210: % is missing.', v_fn;
    end if;

    v_before := v_def;

    -- p_company_id, not l.company_id: the predicate is already scoped to one
    -- company, so this resolves once as a scalar rather than per row.
    v_def := replace(
      v_def,
      'and l.name = ''Depreciation''',
      'and l.id = app_private.ledger_for_role(p_company_id, ''depreciation_amortisation'')'
    );

    if v_def = v_before then
      raise exception '1210: % did not contain the expected depreciation predicate; its body has moved. Fix by hand.', v_fn;
    end if;

    if v_def ~ 'l\.name = ''Depreciation''' then
      raise exception '1210: % still binds depreciation by name after rewrite. Fix by hand.', v_fn;
    end if;

    execute v_def;
  end loop;
end;
$mig$;

-- Nothing outside seed_chart_of_accounts (which names GROUPS, created by the
-- app and never typed by a preparer) may match one of these ledgers by name.
do $mig$
declare
  v_left text;
begin
  select string_agg(n.nspname || '.' || p.proname, ', ' order by p.proname) into v_left
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app_private')
     and p.prokind = 'f'
     and p.proname not in ('seed_chart_of_accounts', 'ensure_stock_ledgers', 'ensure_depreciation_ledgers')
     and pg_get_functiondef(p.oid) ~
         '(l?\.?name = ''(Stock-in-Hand|Changes in Inventories|Depreciation|Accumulated Depreciation)''|ledger_name (=|<>) ''(Depreciation|Accumulated Depreciation)'')';

  if v_left is not null then
    raise exception '1210: these still bind a close ledger by name: %', v_left;
  end if;
end;
$mig$;
