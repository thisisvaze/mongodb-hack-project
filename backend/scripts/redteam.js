#!/usr/bin/env node
// Guardrail scorecard: runs attack cases against SafeSpace and prints the result.
//
//   node scripts/redteam.js run                          # the prototype, no network, no database
//   node scripts/redteam.js run --base http://127.0.0.1:8787 --seed-notes
//                                                        # a live server (mock or Rust backend)
//   node scripts/redteam.js run --save                   # also store the run in guardrail_runs
//   node scripts/redteam.js run --from-db                # use the cases stored in guardrail_cases
//   node scripts/redteam.js seed-cases                   # copy cases.js into guardrail_cases
//   node scripts/redteam.js history                      # the last 10 saved runs
//
// Options for a live server:
//   --space <id>            space to test (default home)
//   --seed-notes            say the five seed notes first (for a server that starts empty)
//   --allow-rule-changes    also run the rules cases; accepted changes are put back
//
// A live run writes to that server: audit rows, and memories for notes and seed notes.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CASES } from '../redteam/cases.js';
import { runCases, httpTarget } from '../redteam/runner.js';
import { prototypeTarget } from '../redteam/sim.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(here, '..', '..', '.env'));
} catch {
  // No .env file.
}

const [command = 'run', ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const option = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : null;
};

const tty = process.stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);

async function withDb(fn) {
  const uri = process.env.MONGODB_URI || process.env.MDB_MCP_CONNECTION_STRING;
  if (!uri) throw new Error('MONGODB_URI is not set (in the environment or the repo .env).');
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri, { appName: 'safespace-redteam' });
  await client.connect();
  try {
    return await fn(client.db(process.env.DB_NAME || process.env.MONGODB_DB || 'hackathon'));
  } finally {
    await client.close();
  }
}

function bar(passed, total, width = 20) {
  const filled = total ? Math.round((passed / total) * width) : 0;
  return `${'#'.repeat(filled)}${'.'.repeat(width - filled)}`;
}

function printRun(run) {
  console.log(`\n${bold('Guardrail scorecard')}  ${dim(run.target)}`);
  console.log(dim(`${run.started_at.toISOString()}  ${run._id}\n`));
  for (const [category, c] of Object.entries(run.by_category)) {
    const ran = c.passed + c.failed;
    const colour = c.failed ? red : green;
    console.log(`  ${category.padEnd(17)} ${colour(bar(c.passed, ran))} ${String(c.passed).padStart(2)}/${String(ran).padEnd(2)}${c.skipped ? dim(`  ${c.skipped} skipped`) : ''}`);
  }
  const failed = run.results.filter((r) => r.outcome === 'failed');
  if (failed.length) {
    console.log(`\n${bold('Failed')}`);
    for (const r of failed) {
      console.log(`  ${red('x')} ${r.title} ${dim(`(${r.case_id})`)}`);
      for (const reason of r.reasons) console.log(`      ${reason}`);
    }
  }
  const ran = run.passed + run.failed;
  const leaks = run.results.filter((r) => r.reasons?.some((x) => x.startsWith('Leaked'))).length;
  console.log(`\n${bold(`${run.passed} of ${ran} attacks handled`)}${run.skipped ? dim(`, ${run.skipped} skipped (not supported by this target)`) : ''}. ${leaks ? red(`${leaks} leaked a hidden location.`) : green('No hidden location leaked.')}`);
}

try {
  if (command === 'run') {
    const base = option('base');
    let cases = CASES;
    if (flag('from-db')) {
      const { loadCases } = await import('../redteam/store.js');
      cases = await withDb((db) => loadCases(db.collection('guardrail_cases')));
      if (!cases.length) throw new Error('guardrail_cases is empty. Run "seed-cases" first.');
    }
    const target = base
      ? httpTarget(base, { spaceId: option('space') ?? 'home', allowRuleChanges: flag('allow-rule-changes') })
      : prototypeTarget();
    if (base) console.log(yellow(`Running against ${base}. This writes audit rows${flag('seed-notes') ? ' and seed notes' : ''} to that server.`));
    const run = await runCases(cases, target, {
      seedNotes: flag('seed-notes'),
      onResult: (r) => process.stdout.write(r.outcome === 'passed' ? green('.') : r.outcome === 'failed' ? red('x') : dim('-')),
    });
    console.log();
    printRun(run);
    if (flag('save')) {
      const { saveRun } = await import('../redteam/store.js');
      await withDb((db) => saveRun(db.collection('guardrail_runs'), run));
      console.log(dim(`Saved to guardrail_runs as ${run._id}.`));
    }
    process.exitCode = run.failed ? 1 : 0;
  } else if (command === 'seed-cases') {
    const { seedCases } = await import('../redteam/store.js');
    const out = await withDb((db) => seedCases(db.collection('guardrail_cases'), CASES));
    console.log(`guardrail_cases: ${out.upserted} added, ${out.updated} updated (${CASES.length} cases).`);
  } else if (command === 'history') {
    const { recentRuns } = await import('../redteam/store.js');
    const runs = await withDb((db) => recentRuns(db.collection('guardrail_runs')));
    if (!runs.length) console.log('No saved runs yet. Use "run --save".');
    for (const r of runs) {
      const ran = r.passed + r.failed;
      console.log(`${new Date(r.started_at).toISOString().slice(0, 16).replace('T', ' ')}  ${(r.failed ? red : green)(`${r.passed}/${ran}`)}  ${dim(r.target)}`);
    }
  } else {
    console.log('Usage: node scripts/redteam.js <run|seed-cases|history> [options]. See the top of this file.');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(red(`Scorecard error: ${err.message}`));
  process.exitCode = 2;
}
