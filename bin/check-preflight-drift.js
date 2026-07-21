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

    if (missing.length) {
        console.error('drift-gate: mapped handler(s) not found in the checkout:\n  ' + missing.join('\n  '));
        process.exit(1);
    }
    if (drift.length) {
        console.error('drift-gate: indexer validity logic changed without a paired pre-flight review.\n' +
            'Re-read each handler, update the matching checks/ module (or confirm no client-visible\n' +
            'change), then refresh the hash in src/preflight/INDEXER-MAP.md:\n');
        for (const d of drift) console.error(`  ${d.handler}\n    was ${d.expected}\n    now ${d.actual}`);
        process.exit(1);
    }

    console.log(`drift-gate: ${rows.length} mapped handler(s) in sync.`);
    process.exit(0);
}

if (require.main === module) main();
module.exports = { resolveIndexerRoot, parseMap };
