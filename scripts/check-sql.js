#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Parses every migration and SQL test against the real Postgres grammar,
// without needing a database.
//
//   npm run check:sql
//
// This catches syntax errors and malformed PL/pgSQL bodies at the point of
// writing rather than at deploy. It does NOT check semantics — whether a
// referenced function exists, whether types line up, or whether an assertion
// actually holds. Those need `supabase/tests/guarantees.sql` run against a
// live database. Treat this as the fast gate, not the real one.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const mod = require('pg-query-emscripten');

const BACKSLASH = String.fromCharCode(92);
const ROOT = path.join(__dirname, '..', 'supabase');

function collect(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(dir, f));
}

(async () => {
  const files = [
    ...collect(path.join(ROOT, 'migrations')),
    ...collect(path.join(ROOT, 'tests')),
    ...collect(path.join(ROOT, 'seeds')),
  ];

  if (files.length === 0) {
    console.log('No SQL files found under supabase/.');
    process.exit(0);
  }

  let failed = 0;

  for (const file of files) {
    // psql meta-commands (\echo, \set) are client-side, not SQL.
    const sql = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trimStart()[0] !== BACKSLASH)
      .join('\n');

    const name = path.relative(ROOT, file).split(path.sep).join('/');

    // A fresh WASM instance per file. The parser accumulates internal state
    // across calls and faults after a handful of them — reusing one instance
    // produced an emscripten crash on the fourth file that vanished when that
    // same file was parsed first. Instantiation is cheap enough at this scale.
    let pg;
    let parsed;
    let plpgsql;
    try {
      pg = await mod.default();
      parsed = pg.parse(sql);
      plpgsql = parsed.error ? null : pg.parsePlpgsql(sql);
    } catch (err) {
      failed++;
      console.error(`FAIL  ${name}  — parser crashed`);
      console.error(`      ${err.message}`);
      continue;
    }

    if (parsed.error) {
      failed++;
      console.error(`FAIL  ${name}`);
      console.error(`      ${parsed.error.message}  (cursor ${parsed.error.cursorpos ?? '?'})`);
      if (parsed.error.cursorpos) {
        const from = Math.max(0, parsed.error.cursorpos - 90);
        console.error(`      near: ${JSON.stringify(sql.slice(from, parsed.error.cursorpos + 50))}`);
      }
      continue;
    }

    // parse() treats a function body as an opaque string literal, so the
    // PL/pgSQL inside every trigger and RPC would otherwise go unchecked.
    if (plpgsql.error) {
      failed++;
      console.error(`FAIL  ${name}  — SQL parses, but a PL/pgSQL body does not`);
      console.error(`      ${plpgsql.error.message}`);
      continue;
    }

    const statements = parsed.parse_tree?.stmts?.length ?? 0;
    const bodies = plpgsql.plpgsql_funcs?.length ?? 0;
    console.log(`ok    ${name}  (${statements} statements, ${bodies} plpgsql bodies)`);
  }

  if (failed) {
    console.error(`\n${failed} file(s) failed to parse.`);
    process.exit(1);
  }
  console.log(`\nAll ${files.length} SQL file(s) parse cleanly.`);
})();
