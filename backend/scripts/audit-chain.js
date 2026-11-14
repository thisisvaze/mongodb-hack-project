#!/usr/bin/env node
// Tamper-evident audit log for SafeSpace.
//
//   node scripts/audit-chain.js seal [--space home] [--adopt-existing]
//   node scripts/audit-chain.js verify [--space home]
//   node scripts/audit-chain.js watch
//
// seal      Seals audit rows that have no seal yet. Rows older than a minute
//           are left unsealed, unless --adopt-existing (use once, to start).
// verify    Checks every chain and lists what was changed, deleted or added.
//           Exits with code 1 if anything is wrong.
// watch     Seals each new row as it is written and checks again whenever a
//           row is edited or deleted. Leave it running next to the backend.
//
// Reads MONGODB_URI (or MDB_MCP_CONNECTION_STRING), DB_NAME (default
// "hackathon") and AUDIT_CHAIN_KEY from the environment or the repo's .env.

import { MongoClient } from 'mongodb';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensureChainIndexes, sealPending, verifySpaces, watchAndSeal } from '../audit/sealer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(here, '..', '..', '.env'));
} catch {
  // No .env file: use the real environment only.
}

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => rest.includes(`--${name}`);
const option = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : null;
};

const uri = process.env.MONGODB_URI || process.env.MDB_MCP_CONNECTION_STRING;
const dbName = process.env.DB_NAME || process.env.MONGODB_DB || 'hackathon';
const key = process.env.AUDIT_CHAIN_KEY || null;
const spaceId = option('space');

const tty = process.stdout.isTTY;
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);

if (!['seal', 'verify', 'watch'].includes(command)) {
  console.log('Usage: node scripts/audit-chain.js <seal|verify|watch> [--space <space_id>] [--adopt-existing]');
  process.exit(2);
}
if (!uri) {
  console.error('MONGODB_URI is not set (in the environment or the repo .env).');
  process.exit(2);
}
if (!key) {
  console.warn(dim('AUDIT_CHAIN_KEY is not set, so seals are plain SHA-256. Someone who can write to the database could rebuild them. Set a long random key for the demo.'));
}

function printReports(reports) {
  let bad = 0;
  for (const r of reports) {
    if (r.ok) {
      console.log(`${green('OK')}   ${r.spaceId}: ${r.checked} sealed row${r.checked === 1 ? '' : 's'}, chain intact.`);
    } else {
      bad++;
      console.log(`${red('FAIL')} ${r.spaceId}: ${r.issues.length} problem${r.issues.length === 1 ? '' : 's'} in ${r.checked} sealed rows.`);
      for (const issue of r.issues) console.log(`     ${red(issue.kind.padEnd(11))} ${issue.message}`);
    }
  }
  return bad;
}

const client = new MongoClient(uri, { appName: 'safespace-audit-chain' });
try {
  await client.connect();
  const db = client.db(dbName);
  const audit = db.collection('audit_events');
  const chain = db.collection('audit_chain');

  if (command === 'seal') {
    await ensureChainIndexes(chain);
    const out = await sealPending({ audit, chain, key, spaceId, adoptExisting: flag('adopt-existing') });
    console.log(`Sealed ${out.sealed} row${out.sealed === 1 ? '' : 's'}.`);
    if (out.late.length) console.log(dim(`Left ${out.late.length} older row${out.late.length === 1 ? '' : 's'} unsealed. Run with --adopt-existing once to start a chain from existing rows.`));
    if (out.conflicts) console.log(dim('Another sealer was writing at the same time; run again to catch up.'));
  }

  if (command === 'verify') {
    const bad = printReports(await verifySpaces({ audit, chain, key, spaceId }));
    process.exitCode = bad ? 1 : 0;
  }

  if (command === 'watch') {
    await ensureChainIndexes(chain);
    const first = await sealPending({ audit, chain, key });
    console.log(`Watching ${dbName}.audit_events. Sealed ${first.sealed} waiting row${first.sealed === 1 ? '' : 's'}. Ctrl+C to stop.`);
    const stop = new AbortController();
    process.on('SIGINT', () => stop.abort());
    await watchAndSeal({
      audit,
      chain,
      key,
      signal: stop.signal,
      onEvent: (e) => {
        const time = new Date().toTimeString().slice(0, 8);
        if (e.type === 'sealed') console.log(`${dim(time)} sealed ${e.count} new row${e.count === 1 ? '' : 's'} in ${e.spaceId}`);
        if (e.type === 'tamper') {
          console.log(`${dim(time)} ${red('ALERT')} audit row ${e.change.id} was ${e.change.operationType === 'delete' ? 'deleted' : 'edited'} in ${e.spaceId}`);
          printReports([e.report]);
        }
      },
    }).catch((err) => {
      if (!stop.signal.aborted) throw err;
    });
  }
} catch (err) {
  console.error(red(`Audit chain error: ${err.message}`));
  process.exitCode = 2;
} finally {
  await client.close();
}
