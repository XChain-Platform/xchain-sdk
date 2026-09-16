#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * Sibling resolution for the pre-flight drift gate (bin/check-preflight-drift.js).
 *
 * WHY IT IS ITS OWN FILE. The gate is already over the repo's 400-line limit and may not
 * grow, and this is the part that is about FINDING the checkout rather than about
 * comparing handlers.
 *
 * WHY IT REPORTS PER CANDIDATE. Treating an unresolved checkout as a reason to print
 * "skipping the sibling checks" and exit 0 answers with a clean run having compared
 * nothing. Two separate things hide behind that: a standalone clone with no sibling at
 * all, and a sibling that
 * IS checked out but whose layout this gate no longer recognises (a renamed handler
 * directory, a checkout of the wrong repo, a path typo in XCHAIN_INDEXER_PATH). The second
 * is a broken gate reading green, so the two are reported apart and both are fatal unless
 * a run declares the standalone case in the environment.
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');

/* What identifies a candidate directory as an xchain-indexer checkout: the handler
 * directory the map's rows name. Without it there is nothing for the gate to hash,
 * whatever else the directory holds. */
const INDEXER_MARKER = path.join('src', 'actions');

/* Set to 1 to declare that this run has no indexer checkout on purpose (a standalone SDK
 * clone). An environment variable, so the choice is made by the run that knows, and it is
 * never inferred from a directory being absent. XCHAIN_REQUIRE_SIBLINGS=1 overrides it:
 * a sibling job that sets both is declaring the checkout supplied, and that is the
 * stricter of the two claims. */
const ALLOW_NO_INDEXER_ENV = 'XCHAIN_ALLOW_NO_INDEXER';

/* Where the gate looks for the handlers, in order.
 *
 * An explicit XCHAIN_INDEXER_PATH is AUTHORITATIVE: falling back to the sibling when the
 * named path does not resolve would check a different tree than the run declared, and
 * report in-sync about handlers nobody asked about.
 */
function indexerRootCandidates() {
    if (process.env.XCHAIN_INDEXER_PATH) return [process.env.XCHAIN_INDEXER_PATH];
    return [path.join(__dirname, '..', '..', 'xchain-indexer')];
}

/* Each candidate with the reason it was accepted or rejected. "Not there" and "there but
 * unreadable as an indexer checkout" have different fixes, so they are never collapsed
 * into one line. */
function describeIndexerCandidates(candidates) {
    return (candidates || indexerRootCandidates()).map((root) => {
        if (!fs.existsSync(root)) {
            return { root, resolved: false, why: 'no such directory' };
        }
        if (!fs.existsSync(path.join(root, INDEXER_MARKER))) {
            return {
                root,
                resolved: false,
                why: `the directory is there but holds no ${INDEXER_MARKER}/, so it is not an`
                    + ' xchain-indexer checkout this gate can read',
            };
        }
        return { root, resolved: true, why: `holds ${INDEXER_MARKER}/` };
    });
}

function resolveIndexerRoot() {
    for (const c of describeIndexerCandidates()) {
        if (c.resolved) return c.root;
    }
    return null;
}

/* True when the run has DECLARED that it has no indexer checkout. Only an explicit
 * environment override counts; a missing directory is an accident of layout, not a
 * decision, and reading it as one is what retired the gate silently. */
function noIndexerIsDeclared() {
    // Read by its literal name (the constant above names it for messages) so the
    // env-var doc coverage scanner sees the variable rather than a computed key.
    return process.env.XCHAIN_ALLOW_NO_INDEXER === '1'
        && process.env.XCHAIN_REQUIRE_SIBLINGS !== '1';
}

/* The text an unresolved checkout prints: what was looked for, where it was looked for,
 * and why each place was rejected, so the reader can tell a dropped CI checkout step from
 * a layout change without opening this file. */
function unresolvedReport() {
    const lines = [
        'drift-gate: FAIL: no xchain-indexer checkout resolved, so no mapped handler was',
        `compared. Looked for a directory holding ${INDEXER_MARKER}/ at:`,
    ];
    for (const c of describeIndexerCandidates()) {
        lines.push(`  ${c.root}`);
        lines.push(`      ${c.why}`);
    }
    lines.push('');
    lines.push('Check the sibling out, or point XCHAIN_INDEXER_PATH at it. A run that has no');
    lines.push(`indexer checkout ON PURPOSE (a standalone SDK clone) sets ${ALLOW_NO_INDEXER_ENV}=1,`);
    lines.push('which is a choice a reader can see, unlike a silent skip.');
    return lines.join('\n');
}

module.exports = {
    INDEXER_MARKER,
    ALLOW_NO_INDEXER_ENV,
    indexerRootCandidates,
    describeIndexerCandidates,
    resolveIndexerRoot,
    noIndexerIsDeclared,
    unresolvedReport,
};
