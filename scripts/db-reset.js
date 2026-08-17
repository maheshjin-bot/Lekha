#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Rebuilds the local database from scratch and runs the guarantees.
//
//   npm run db:reset
//
// Drops and recreates the target database, applies the Supabase stub, then
// every migration in filename order, then supabase/tests/guarantees.sql.
// Fails on the first error, loudly — these migrations are not idempotent and
// each depends on the last, so a partial apply is worse than no apply.
//
// Connection comes from standard libpq environment variables. Nothing here
// reads, stores or prints a password: psql resolves credentials itself from
// %APPDATA%\postgresql\pgpass.conf (or ~/.pgpass), which is the only place a
// password should live.
//
//   PGHOST     default localhost
//   PGPORT     default 5432
//   PGUSER     default postgres
//   PGDATABASE default lekha_dev   (the database this script rebuilds)
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PSQL = process.env.PSQL || 'psql';
const HOST = process.env.PGHOST || 'localhost';
const PORT = process.env.PGPORT || '5432';
const USER = process.env.PGUSER || 'postgres';
const DB = process.env.PGDATABASE || 'lekha_dev';

const ROOT = path.join(__dirname, '..', 'supabase');

function psql(args, { db = DB, input = null, label } = {}) {
  const full = ['-w', '-h', HOST, '-p', PORT, '-U', USER, '-d', db, '-v', 'ON_ERROR_STOP=1', ...args];
  const res = spawnSync(PSQL, full, {
    encoding: 'utf8',
    input: input ?? undefined,
    // PGPASSWORD is deliberately not set here. psql reads pgpass itself.
    env: process.env,
  });

  if (res.error && res.error.code === 'ENOENT') {
    console.error(
      `\nCould not run "${PSQL}". Add the PostgreSQL bin directory to PATH, or set PSQL to its full path:\n` +
        `  $env:PSQL = "C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe"\n`
    );
    process.exit(1);
  }

  const out = (res.stdout || '') + (res.stderr || '');
  if (res.status !== 0) {
    console.error(`\nFAILED: ${label}`);
    console.error(out.trim());
    process.exit(res.status || 1);
  }
  return out;
}

function runFile(file, label) {
  process.stdout.write(`  ${label} ... `);
  const out = psql(['-f', file], { label });
  // Surface NOTICEs from the guarantees script; suppress routine chatter.
  const notices = out
    .split('\n')
    .filter((l) => l.includes('ok  ') || l.startsWith('NOTICE') === false && l.trim().startsWith('ok '))
    .length;
  console.log(notices ? `done (${notices} assertions)` : 'done');
  return out;
}

function collect(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().map((f) => path.join(dir, f));
}

console.log(`\nRebuilding ${USER}@${HOST}:${PORT}/${DB}\n`);

// Connect to the maintenance database to drop/create the target.
psql(['-c', `drop database if exists ${DB} with (force)`], { db: 'postgres', label: 'drop database' });
psql(['-c', `create database ${DB}`], { db: 'postgres', label: 'create database' });
console.log('  database recreated');

console.log('\nSupabase stub');
runFile(path.join(ROOT, 'tests', 'local_bootstrap.sql'), 'local_bootstrap.sql');

console.log('\nMigrations');
const migrations = collect(path.join(ROOT, 'migrations'));
if (!migrations.length) {
  console.error('  no migrations found');
  process.exit(1);
}
for (const m of migrations) runFile(m, path.basename(m));

console.log('\nGuarantees');
const guarantees = path.join(ROOT, 'tests', 'guarantees.sql');
if (fs.existsSync(guarantees)) {
  const out = runFile(guarantees, 'guarantees.sql');
  const failed = out.match(/FAILED: .*/g);
  if (failed) {
    console.error('\n' + failed.join('\n'));
    process.exit(1);
  }
} else {
  console.log('  (none)');
}

console.log('\nDatabase rebuilt and all guarantees held.\n');
