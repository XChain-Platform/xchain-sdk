'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pins loadBatchArbiter, the one loader the BATCH arbiter halves share: a
// checkout that is absent or fails to load skips in a soft run and fails in a
// strict one, so a strict lane never passes with the arbiter half pending.

const { expect } = require('chai');
const path = require('path');
const { loadBatchArbiter } = require('../../helpers/indexer_action_handler.js');

const FAKE_ROOT = path.join(path.sep, 'nonexistent', 'xchain-indexer');
const WHAT = 'the loader under test';

// A mocha-context stand-in that records skip() instead of throwing Pending.
function fakeContext() {
    return { skipped: 0, skip() { this.skipped++; } };
}

function fakeLoad() {
    return { root: FAKE_ROOT, Handler: function Batch() {} };
}

// A require that throws for one support module and answers the rest.
function throwingRequire(failing) {
    return (file) => {
        if (path.basename(file) === failing) throw new Error('boom: ' + failing);
        return { loaded: path.basename(file) };
    };
}

describe('loadBatchArbiter: arbiter-half loader for the BATCH conformance suites', function () {
    let saved;
    beforeEach(function () { saved = process.env.XCHAIN_REQUIRE_SIBLINGS; });
    afterEach(function () {
        if (saved === undefined) delete process.env.XCHAIN_REQUIRE_SIBLINGS;
        else process.env.XCHAIN_REQUIRE_SIBLINGS = saved;
    });

    it('fails a strict run when a support module throws at load, naming the error', function () {
        process.env.XCHAIN_REQUIRE_SIBLINGS = '1';
        const ctx = fakeContext();
        expect(() => loadBatchArbiter(ctx, WHAT, { loadAction: fakeLoad, require: throwingRequire('config.js') }))
            .to.throw(/XCHAIN_REQUIRE_SIBLINGS=1 but the loader under test cannot run: .*boom: config\.js/);
        expect(ctx.skipped).to.equal(0);
    });

    it('skips a soft run when a support module throws at load', function () {
        delete process.env.XCHAIN_REQUIRE_SIBLINGS;
        const ctx = fakeContext();
        const got = loadBatchArbiter(ctx, WHAT, { loadAction: fakeLoad, require: throwingRequire('protocol_changes.js') });
        expect(got).to.equal(null);
        expect(ctx.skipped).to.equal(1);
    });

    it('fails a strict run when no indexer checkout resolves, and skips a soft one', function () {
        process.env.XCHAIN_REQUIRE_SIBLINGS = '1';
        expect(() => loadBatchArbiter(fakeContext(), WHAT, { loadAction: () => null }))
            .to.throw(/XCHAIN_REQUIRE_SIBLINGS=1 but the loader under test cannot run: no xchain-indexer/);
        delete process.env.XCHAIN_REQUIRE_SIBLINGS;
        const ctx = fakeContext();
        expect(loadBatchArbiter(ctx, WHAT, { loadAction: () => null })).to.equal(null);
        expect(ctx.skipped).to.equal(1);
    });

    it('returns the handler and the three support modules when everything loads', function () {
        process.env.XCHAIN_REQUIRE_SIBLINGS = '1';
        const ctx = fakeContext();
        const got = loadBatchArbiter(ctx, WHAT, { loadAction: fakeLoad, require: throwingRequire('none') });
        expect(got.Batch.name).to.equal('Batch');
        expect([got.IdxUtility, got.IdxConfig, got.ProtocolChanges].map((m) => m.loaded))
            .to.deep.equal(['utility.js', 'config.js', 'protocol_changes.js']);
        expect(ctx.skipped).to.equal(0);
    });
});
