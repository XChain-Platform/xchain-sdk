'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// What this suite exists to stop: a GREEN run that verified less than it looks
// like it did.
//
// Roughly thirty cross-repo guards in test/unit are byte-identity or value-parity
// checks against a SIBLING checkout (the vendored coins registry against
// xchain-hub, abi-core against xchain-explorer, the reference implementations
// against xchain-documentation, and so on). Every one of them resolves its
// sibling with existsSync and calls this.skip() when it is absent. That is the
// right behaviour for a single-repo checkout, and it is invisible: mocha reports
// a skipped test as `pending`, the suite still exits 0, and the push gate prints
// PASS. Measured on test-host 2026-08-12, the venue ran 3444 passing / 40 pending
// where a full local checkout runs 3515 / 4, so ~36 vendored-copy guards had
// silently not run and nothing in the output said so.
//
// This file does not intercept those skips (that would mean rewriting eighteen
// suites and is the sort of churn that breaks the guards it means to protect).
// It answers the question their silence leaves open: WHICH siblings were
// resolvable for this run, and therefore which guard families could not have
// run. The summary prints on every run, pass or fail.
//
// XCHAIN_REQUIRE_SIBLINGS=1 turns absence into a FAILURE. That switch already
// existed and thirteen suites honour it; this makes it enforceable in one place,
// so a venue that is supposed to carry the full checkout proves it rather than
// asserting it. Default (unset) stays permissive so a single-repo clone is green.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const REPO_ROOT    = path.join(__dirname, '..', '..');
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(REPO_ROOT, '..');
const STRICT       = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// Each entry names a sibling checkout, the env overrides the existing suites
// already read for it (first one set wins, so this resolves exactly as they do),
// a path that must exist inside it to count as a real checkout rather than an
// empty directory, and the guard family that goes quiet when it is missing.
const SIBLINGS = [
    { repo: 'xchain-hub',           envs: ['XCHAIN_HUB_DIR'],
      marker: 'src/coins',
      guards: 'vendored coins registry byte-identity (BTC/LTC/DOGE/index/consensus_pin)' },
    { repo: 'xchain-indexer',       envs: ['XCHAIN_INDEXER_PATH', 'XCHAIN_INDEXER_DIR'],
      marker: 'src/actions',
      guards: 'the §8.5 pre-flight drift gate over the mapped handlers' },
    { repo: 'xchain-explorer',      envs: ['XCHAIN_EXPLORER_DIR'],
      marker: 'src',
      guards: 'abi-core drift and the typed explorer-route contract' },
    { repo: 'xchain-documentation', envs: ['XCHAIN_DOCS_DIR', 'XCHAIN_DOCUMENTATION_DIR'],
      marker: 'protocol',
      guards: 'consensus reference-impl parity (quorum, equivocation, reorg buffer) and the canonical action map' },
    { repo: 'xchain-encoder',       envs: ['XCHAIN_ENCODER_DIR'],
      marker: 'src',
      guards: 'the vendored roundtrip-conformance fixture' },
    { repo: 'xchain-decoder',       envs: ['XCHAIN_DECODER_DIR'],
      marker: 'src',
      guards: 'co-signer decode parity against the authoritative decoder' },
    { repo: 'xchain-vm',            envs: ['XCHAIN_VM_DIR'],
      marker: 'src',
      guards: 'lint-core and metering vendored-copy parity' },
    { repo: 'xchain-sync',          envs: ['XCHAIN_SYNC_DIR'],
      marker: 'src',
      guards: 'cross-repo consensus-constant byte-identity' },
    { repo: 'xchain-wallet',        envs: ['XCHAIN_WALLET_DIR'],
      marker: 'packages',
      guards: 'BIP44 derivation-path parity and the XCALL constant copy' },
    // Marker is a TEMPLATE, not src/: xchain-contracts is laid out one directory
    // per contract with no src/ at all, and contract-parity.test.js keys off
    // <name>/<name>.js. A src/ marker here reported the repo absent while it sat
    // right there, which is the same false-confidence bug pointed the other way.
    { repo: 'xchain-contracts',     envs: ['XCHAIN_CONTRACTS_DIR'],
      marker: path.join('escrow', 'escrow.js'),
      guards: 'contract template parity (escrow, vesting, crowdsale, amm)' },
];

function resolve(entry) {
    for (const key of entry.envs) {
        if (process.env[key]) return { dir: process.env[key], via: key };
    }
    return { dir: path.join(SIBLING_ROOT, entry.repo), via: 'sibling root' };
}

// Present means "a real checkout", not merely "a directory exists": an empty
// placeholder would resolve and then every guard inside it would still skip,
// which is the exact silence this file exists to break.
function inspect(entry) {
    const { dir, via } = resolve(entry);
    const present = fs.existsSync(dir) && fs.existsSync(path.join(dir, entry.marker));
    return { ...entry, dir, via, present };
}

describe('cross-repo sibling coverage (what this run could NOT verify)', function () {

    const results = SIBLINGS.map(inspect);
    const absent  = results.filter(r => !r.present);

    // Prints on every run. A reader of CI output should never have to diff two
    // pending counts to discover that a vendored-copy guard did not run.
    before(function () {
        const mode = STRICT ? 'STRICT (absence fails)' : 'permissive (absence skips)';
        console.log(`      sibling coverage: ${results.length - absent.length}/${results.length} resolvable, ${mode}`);
        for (const r of absent) {
            console.log(`      NOT VERIFIED: ${r.repo} absent at ${r.dir} (${r.via}) -> ${r.guards}`);
        }
    });

    it('reports every sibling it looked for, so the list itself cannot rot silently', function () {
        // A guard that checks nothing is the failure mode being prevented, so the
        // roster must be non-empty and every entry must be answerable.
        expect(results.length).to.be.greaterThan(0);
        for (const r of results) {
            expect(r.dir, `${r.repo} resolved to nothing`).to.be.a('string').and.not.equal('');
            expect(r.present, `${r.repo} presence must be a decided boolean`).to.be.a('boolean');
        }
    });

    it('resolves every sibling checkout the cross-repo guards depend on', function () {
        if (!absent.length) return;
        const detail = absent.map(r => `${r.repo} (expected ${r.dir}, via ${r.via}; silences ${r.guards})`).join('; ');
        if (STRICT) {
            throw new Error(
                `XCHAIN_REQUIRE_SIBLINGS=1 but ${absent.length} sibling checkout(s) are missing: ${detail}. `
                + 'Every cross-repo parity guard against them skipped, so this run proves less than a green '
                + 'result suggests. Check the siblings out, or unset XCHAIN_REQUIRE_SIBLINGS to accept the gap.');
        }
        // Permissive mode: recorded above and in the pending list, never a failure,
        // so a single-repo clone stays green.
        this.skip();
    });
});
