#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * Pre-flight ↔ indexer-handler drift gate (spec §8.5).
 *
 * Reads src/preflight/INDEXER-MAP.md, resolves the sibling
 * xchain-indexer checkout, and fails when any mapped handler's SHA-256
 * no longer matches the recorded hash - meaning an indexer validity
 * change landed without a paired review/update of the client check.
 *
 * SKIPS (exit 0) when no indexer checkout is present, so single-repo
 * CI stays green; the sibling CI job (which checks out both) enforces.
 *
 * Exit 0 = in sync (or skipped); exit 1 = drift.
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function resolveIndexerRoot() {
    const candidates = [
        process.env.XCHAIN_INDEXER_PATH,
        path.join(__dirname, '..', '..', 'xchain-indexer'),
    ].filter(Boolean);
    for (const root of candidates) {
        if (fs.existsSync(path.join(root, 'src', 'actions'))) return root;
    }
    return null;
}

function parseMap(mapPath) {
    const text = fs.readFileSync(mapPath, 'utf8');
    const rows = [];
    // | ... | `src/actions/x.js` | `<hash>` |
    const re = /\|\s*`(src\/actions\/[^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|/g;
    let m;
    while ((m = re.exec(text)) !== null) rows.push({ handler: m[1], hash: m[2] });
    return rows;
}

/* The fee-quote seam, which the hash rows above structurally cannot cover ().
 *
 * Every mapped row is a per-handler file under src/actions/, so the row regex carries a
 * literal `src/actions/` prefix and can never match the TOP-LEVEL src/actions.js. That is the
 * file defining FEE_QUOTE_DENYLIST and FEE_QUOTE_STATIC, and until now the only thing binding
 * them to the SDK's TIER1_DENYLIST was a hand-written comment, which had already drifted
 * ().
 *
 * Compared by VALUE rather than by hash on purpose. Hashing all of actions.js would fire on
 * every unrelated edit to a large file, and anchor-scoped hashing can silently lose coverage
 * when a marker moves, which is the worse failure for financial logic. The invariant that
 * actually matters is not "actions.js is unchanged", it is that the two lists agree, so check
 * exactly that and fail closed when either literal cannot be read.
 */
function parseStringSet(text, name, where) {
    // const NAME = new Set([...]) | Object.freeze([...]) | [...]
    const re = new RegExp('const\\s+' + name + '\\s*=\\s*(?:new Set\\(|Object\\.freeze\\()?\\s*\\[([^\\]]*)\\]', 'g');
    const hits = [];
    let m;
    while ((m = re.exec(text)) !== null) hits.push(m[1]);
    if (hits.length !== 1) {
        throw new Error(`drift-gate: expected exactly one ${name} declaration in ${where}, found ${hits.length}. `
            + 'That literal is what this gate compares; find where it moved before editing this check.');
    }
    return [...new Set([...hits[0].matchAll(/['"]([A-Z_]+)['"]/g)].map((x) => x[1]))].sort();
}

function checkFeeQuoteSeam(indexerRoot) {
    const actionsPath = path.join(indexerRoot, 'src', 'actions.js');
    if (!fs.existsSync(actionsPath)) {
        console.error('drift-gate: xchain-indexer/src/actions.js not found; it defines the fee-quote lists this gate pins.');
        return 1;
    }
    const indexerSrc = fs.readFileSync(actionsPath, 'utf8');
    const sdkSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preflight', 'constants.js'), 'utf8');

    const denylist = parseStringSet(indexerSrc, 'FEE_QUOTE_DENYLIST', 'xchain-indexer/src/actions.js');
    const staticSet = parseStringSet(indexerSrc, 'FEE_QUOTE_STATIC', 'xchain-indexer/src/actions.js');
    const tier1 = parseStringSet(sdkSrc, 'TIER1_DENYLIST', 'src/preflight/constants.js');

    let failed = 0;
    if (denylist.join(',') !== tier1.join(',')) {
        console.error('drift-gate: TIER1_DENYLIST no longer mirrors the indexer FEE_QUOTE_DENYLIST.\n'
            + `  indexer FEE_QUOTE_DENYLIST: ${denylist.join(', ')}\n`
            + `  sdk     TIER1_DENYLIST:     ${tier1.join(', ')}\n`
            + '  Tier 1 would start dry-running an action the indexer refuses to quote, or stop\n'
            + '  short-circuiting one it does. Update src/preflight/constants.js to match.');
        failed = 1;
    }
    // runTier1 returns early on TIER1_DENYLIST, which is the ONLY reason its no-verdict branch
    // cannot swallow a static valid:null quote and drop its priced fee (). That
    // reachability argument holds only while STATIC stays inside the denylist.
    const escaped = staticSet.filter((a) => !tier1.includes(a));
    if (escaped.length) {
        console.error('drift-gate: FEE_QUOTE_STATIC action(s) outside TIER1_DENYLIST: ' + escaped.join(', ') + '\n'
            + '  These now reach runTier1\'s endpoint call, whose no-verdict branch returns without\n'
            + '  attaching the quote, so the  gas-schedule fee would be silently dropped.');
        failed = 1;
    }
    if (!failed) {
        console.log(`drift-gate: fee-quote seam in sync (denylist ${tier1.length} action(s), `
            + `${staticSet.length} static-quoted, all denylisted).`);
    }
    return failed;
}

function main() {
    const mapPath = path.join(__dirname, '..', 'src', 'preflight', 'INDEXER-MAP.md');
    if (!fs.existsSync(mapPath)) {
        console.error('drift-gate: INDEXER-MAP.md not found');
        process.exit(1);
    }
    const root = resolveIndexerRoot();
    if (!root) {
        console.log('drift-gate: no xchain-indexer checkout; skipping (sibling CI enforces).');
        process.exit(0);
    }

    const rows = parseMap(mapPath);
    if (rows.length === 0) {
        console.error('drift-gate: no mapping rows parsed from INDEXER-MAP.md');
        process.exit(1);
    }

    const drift = [];
    const missing = [];
    for (const { handler, hash } of rows) {
        const abs = path.join(root, handler);
        if (!fs.existsSync(abs)) { missing.push(handler); continue; }
        const actual = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        if (actual !== hash) drift.push({ handler, expected: hash, actual });
    }

    // Report every independent check before exiting, never on the first failure: handler-hash
    // drift and a fee-quote seam break have different causes and different fixes, and exiting
    // on the first one would let unrelated stale hashes hide a live seam break behind them.
    let failed = 0;

    if (missing.length) {
        console.error('drift-gate: mapped handler(s) not found in the checkout:\n  ' + missing.join('\n  '));
        failed = 1;
    }
    if (drift.length) {
        console.error('drift-gate: indexer validity logic changed without a paired pre-flight review.\n' +
            'Re-read each handler, update the matching checks/ module (or confirm no client-visible\n' +
            'change), then refresh the hash in src/preflight/INDEXER-MAP.md:\n');
        for (const d of drift) console.error(`  ${d.handler}\n    was ${d.expected}\n    now ${d.actual}`);
        failed = 1;
    }

    // parseStringSet throws when a literal cannot be read exactly once; that is the fail-closed
    // path, so report it as a gate failure rather than an uncaught stack trace.
    try {
        if (checkFeeQuoteSeam(root)) failed = 1;
    } catch (e) {
        console.error(e && e.message ? e.message : String(e));
        failed = 1;
    }

    if (failed) process.exit(1);

    console.log(`drift-gate: ${rows.length} mapped handler(s) in sync.`);
    process.exit(0);
}

if (require.main === module) main();
module.exports = { resolveIndexerRoot, parseMap, parseStringSet, checkFeeQuoteSeam };
