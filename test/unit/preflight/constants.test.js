'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Registry + drift-gate suite (spec §8.5, §8.7). Every quantified
// constant and finding code lives in one module; the certified list
// is the single source (§4.4 error column == this list). The drift
// gate runs here so `npm test` exercises it when a sibling indexer
// checkout is present.

const { expect } = require('chai');
const path = require('path');
const constants = require('../../../src/preflight/constants.js');

function registerRegistryTests() {
    it('every quantified constant is exported (no literals in code)', function () {
        expect(constants.DEFAULT_TIMEOUT_MS).to.equal(4000);
        expect(constants.RECHECK_TIMEOUT_MS).to.equal(2000);
        expect(constants.STALENESS_MS).to.equal(30000);
        expect(constants.ENDPOINT_MEMO_TTL_MS).to.equal(2000);
        expect(constants.REPORT_SCHEMA_VERSION).to.equal(1);
        // OP_RETURN is 75 because the compose gate measures the compiled push,
        // not the raw bytes; the parity suite below proves the two agree.
        expect(constants.ENCODING_LIMITS).to.deep.equal({ OP_RETURN: 75, MULTISIGN: 60, P2SH: 476, P2WSH: 476 });
    });

    it('the certified Tier-2 error list is the single source', function () {
        // Every certified code exists in the finding registry, and each
        // is classified local (non-overridable) or network (overridable).
        for (const [code, cls] of Object.entries(constants.TIER2_ERROR_CAPABLE)) {
            expect(constants.FINDING_CODES[code], code + ' missing from FINDING_CODES').to.equal(code);
            expect(['local', 'network']).to.include(cls);
        }
    });

    it('no check module emits a registry code as a string literal', function () {
        // A literal that equals a FINDING_CODES value is a second copy of the
        // registry: a rename moves every FINDING_CODES.* call site and leaves the
        // literal emitting an off-contract code the wallet can bucket by severity
        // but never match by code. Unverified-only check names with no registry
        // entry are a different class and stay literals, so the scan keys on the
        // registry's VALUES rather than on shape.
        const fs = require('fs');
        const dir = path.join(__dirname, '..', '..', '..', 'src', 'preflight', 'checks');
        const registry = new Set(Object.values(constants.FINDING_CODES));
        const re = /\b(?:addFinding|addUnverified|markRun)\(\s*(['"])([A-Z0-9_]+)\1/g;
        const offenders = [];
        // Check modules can nest (checks/batch/ holds per-command helpers), so the
        // scan walks every subdirectory rather than only the top level, or a
        // literal in a nested file passes unseen.
        function collectCheckFiles(d) {
            const found = [];
            for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
                const full = path.join(d, entry.name);
                if (entry.isDirectory()) found.push(...collectCheckFiles(full));
                else if (entry.isFile() && entry.name.endsWith('.js')) found.push(full);
            }
            return found;
        }
        for (const full of collectCheckFiles(dir)) {
            const src = fs.readFileSync(full, 'utf8');
            let m;
            while ((m = re.exec(src)) !== null) {
                if (registry.has(m[2])) offenders.push(`${path.relative(dir, full)}: '${m[2]}'`);
            }
        }
        expect(offenders, 'registry codes passed as literals: ' + offenders.join(', ')).to.deep.equal([]);
    });
}

function registerDenylistTests() {
    it('TIER1_DENYLIST mirrors the indexer VM denylist', function () {
        expect(constants.TIER1_DENYLIST).to.deep.equal(['DEPLOY', 'EXECUTE', 'XEXEC', 'BATCH']);
    });

    it('TIER1_SUBCOMMAND_PREFLIGHT is a SUBSET of the denylist, not a replacement for it', function () {
        // The exception list only ever relaxes the short-circuit for something the
        // denylist already names; an entry outside it would be meaningless (that
        // action was never short-circuited) and would read as a second denylist.
        expect(constants.TIER1_SUBCOMMAND_PREFLIGHT).to.deep.equal(['BATCH']);
        for (const a of constants.TIER1_SUBCOMMAND_PREFLIGHT)
            expect(constants.TIER1_DENYLIST, a + ' must be on the denylist it excepts').to.include(a);
    });

    it('XEXEC on the denylist is defence-in-depth for an action the SDK cannot compose', function () {
        // XEXEC is arbiter-EMITTED (mirror-injected from the hub mirror),
        // not composed by a client, so there is no wire form for the SDK decoder to
        // parse and sdk.preflight() can never reach this denylist entry. That makes
        // the entry unreachable, not wrong: it mirrors the indexer literal by VALUE
        // (the drift gate binds it that way) and it is the guard that would stand
        // between an unauthenticated caller and VM compute under the block-loop
        // mutex the moment XEXEC gains a format.
        //
        // This test pins the "cannot compose" half. If XEXEC ever becomes
        // client-composable it fails on purpose, and the correct response is to
        // exercise the denylist entry through the real parse path in tier1.test.js,
        // never to delete the entry or this test.
        expect(constants.TIER1_DENYLIST, 'the guard must stay even while unreachable').to.include('XEXEC');

        const formats = require('../../../src/protocol/formats.js');
        expect(Object.keys(formats), 'XEXEC must have no client wire format').to.not.include('XEXEC');

        const { parse } = require('../../../src/decoder/parse.js');
        for (const wire of ['XEXEC', 'XEXEC|0', 'XEXEC|0|1|payload', 'XEXEC|1|contract|method|args']) {
            const r = parse(wire, { validate: false });
            expect(r.ok, wire + ' must not parse').to.equal(false);
            expect(r.code, wire).to.equal('UNKNOWN_ACTION');
        }

        // The action manifest is the platform-wide statement of the same fact.
        const manifest = require('../../fixtures/action-manifest.json');
        expect(manifest.actions.XEXEC.category).to.equal('mirror-injected');
        expect(manifest.actions.XEXEC.wireDecoded, 'XEXEC is not wire-decoded').to.equal(undefined);
        expect(manifest.actions.XEXEC.userEncodable, 'XEXEC is not user-encodable').to.equal(undefined);
    });

    it('the VM-compute actions are NOT exceptable', function () {
        // The denylist exists to keep an unauthenticated caller from running the VM
        // under the block-loop mutex. BATCH is exceptable only because the arbiter
        // refuses its VM sub-actions itself; DEPLOY/EXECUTE/XEXEC ARE the VM, so
        // adding one here would hand out that primitive directly.
        for (const a of ['DEPLOY', 'EXECUTE', 'XEXEC'])
            expect(constants.TIER1_SUBCOMMAND_PREFLIGHT, a).to.not.include(a);
    });
}

describe('pre-flight constants + registry', function () {
    registerRegistryTests();
    registerDenylistTests();
});
