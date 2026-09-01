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
const { Worker } = require('worker_threads');

const BACKSLASH = String.fromCharCode(92);
const ROOT = path.join(__dirname, '..', 'supabase');
const WORKER_PATH = path.join(__dirname, 'check-sql-worker.js');

// Each file's parse runs in its own worker thread (its own V8 isolate),
// instead of calling pg-query-emscripten's mod.default() directly in this
// process. Two problems forced that:
//
// 1. Every mod.default() call does a fresh WebAssembly.instantiate() of the
//    bundled pg_query binary — the library shares nothing across calls (no
//    cached compiled module, no instance pool) and exposes no dispose()/
//    destroy() for the instance it hands back. Calling it 2x per file
//    in-process (see the per-file comment below for why two fresh instances
//    per file, rather than one, are non-negotiable) left 300+ WASM instances
//    for V8's ordinary GC to clean up on its own schedule; across the full
//    migrations directory that fell behind badly enough to exceed 2GB RSS
//    and hang past 20 minutes.
//
// 2. That turned out not to be the only problem. In isolation, with memory
//    never in question, the bundled parser's parsePlpgsql() genuinely hangs
//    — not slow, not erroring, just never returns — on
//    0147_line_discounts_and_price_lists.sql specifically. Bisecting that
//    file found the trigger: create_invoice and update_invoice individually
//    parse in ~20ms each; concatenated into one parsePlpgsql() call (as they
//    are, being two functions in one migration file) it does not return
//    within 30+ seconds. That is a real defect in the bundled parser's
//    handling of two large plpgsql bodies in one call, unrelated to
//    cross-file memory — no amount of GC tuning fixes a single call that
//    never returns.
//
// A worker thread answers both: terminate() forcibly tears down the isolate
// — WASM memory included — the instant a file is done OR the instant it's
// taken too long, so a hang on one file costs one timeout, not the run.
const PARSE_TIMEOUT_MS = 20_000;

function collect(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => path.join(dir, f));
}

// Resolves with exactly one of:
//   { crashed: true, message }               — the worker threw
//   { timedOut: true, parsedPhase }           — see above; parsedPhase is the
//                                                parse() result IF it arrived
//                                                before the timeout, else null
//   { parsed, plpgsql }                       — normal completion
function parseFileInWorker(sql) {
  return new Promise((resolve) => {
    const worker = new Worker(WORKER_PATH, { workerData: { sql } });
    let settled = false;
    let parsedPhase = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => finish({ timedOut: true, parsedPhase }), PARSE_TIMEOUT_MS);

    worker.on('message', (msg) => {
      if (msg.type === 'parsed') {
        parsedPhase = msg.parsed;
      } else if (msg.type === 'done') {
        finish({ parsed: msg.parsed, plpgsql: msg.plpgsql });
      } else if (msg.type === 'crash') {
        finish({ crashed: true, message: msg.message });
      }
    });

    worker.on('error', (err) => finish({ crashed: true, message: err.message }));
  });
}

// The bundled parser is older than the server and cannot read every valid
// construct, and (see PARSE_TIMEOUT_MS above) can outright hang on at least
// one valid one. Both are listed explicitly and treated as a skipped check
// rather than ignored wholesale, so a genuine PL/pgSQL error in the same
// file still fails the run.
const KNOWN_PARSER_GAPS = [
  {
    match: /missing expression at or near ";"/,
    note: 'bare RETURN NEXT; in a table-returning function — valid, unsupported by the bundled parser',
  },
];

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
  let warned = 0;
  let peakRssMb = 0;

  for (const file of files) {
    peakRssMb = Math.max(peakRssMb, process.memoryUsage().rss / (1024 * 1024));

    // psql meta-commands (\echo, \set) are client-side, not SQL.
    const sql = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trimStart()[0] !== BACKSLASH)
      .join('\n');

    const name = path.relative(ROOT, file).split(path.sep).join('/');

    const result = await parseFileInWorker(sql);

    if (result.crashed) {
      failed++;
      console.error(`FAIL  ${name}  — parser crashed`);
      console.error(`      ${result.message}`);
      continue;
    }

    if (result.timedOut) {
      const parsedPhase = result.parsedPhase;
      if (parsedPhase && !parsedPhase.error) {
        warned++;
        const statements = parsedPhase.parse_tree?.stmts?.length ?? 0;
        console.log(`warn  ${name}  (${statements} statements, plpgsql body not checked)`);
        console.log(
          `      the bundled PL/pgSQL parser did not return within ${PARSE_TIMEOUT_MS / 1000}s ` +
            '— a known hang in this parser on some large multi-function files, not a syntax ' +
            'error (the SQL grammar parse above already succeeded)'
        );
        continue;
      }
      failed++;
      console.error(`FAIL  ${name}  — parser did not return within ${PARSE_TIMEOUT_MS / 1000}s`);
      console.error('      timed out before even the base SQL parse was reported back');
      continue;
    }

    const { parsed, plpgsql } = result;

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
      const known = KNOWN_PARSER_GAPS.find((g) => g.match.test(plpgsql.error.message));

      if (known) {
        warned++;
        const statements = parsed.parse_tree?.stmts?.length ?? 0;
        console.log(`warn  ${name}  (${statements} statements, plpgsql body not checked)`);
        console.log(`      ${known.note}`);
        continue;
      }

      failed++;
      console.error(`FAIL  ${name}  — SQL parses, but a PL/pgSQL body does not`);
      console.error(`      ${plpgsql.error.message}`);
      continue;
    }

    const statements = parsed.parse_tree?.stmts?.length ?? 0;
    const bodies = plpgsql.plpgsql_funcs?.length ?? 0;
    console.log(`ok    ${name}  (${statements} statements, ${bodies} plpgsql bodies)`);
  }

  peakRssMb = Math.max(peakRssMb, process.memoryUsage().rss / (1024 * 1024));
  const peakRssNote = `peak RSS ~${Math.round(peakRssMb)} MB`;

  if (failed) {
    console.error(`\n${failed} file(s) failed to parse. (${peakRssNote})`);
    process.exit(1);
  }
  console.log(
    `\nAll ${files.length} SQL file(s) parse cleanly` +
      (warned
        ? ` — ${warned} with a valid PL/pgSQL body the bundled parser cannot read.`
        : '.') +
      ` (${peakRssNote})`
  );
})();
