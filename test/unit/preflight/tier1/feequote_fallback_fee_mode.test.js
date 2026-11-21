'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The legacy /feequote endpoint always dry-runs with a native fee output, so
// when Tier 1 falls back to it the answer is a verdict only in native fee mode.
// In XCHAIN mode (the Bitcoin default) it would stand in for a fee debit it
// never checked, so Tier 1 returns a disclosed no-verdict and Tier 2 stands.

const { expect } = require('chai');
const { runTier1 } = require('../../../../src/preflight/tier1.js');
const { parse } = require('../../../../src/decoder/parse.js');
const { mockSdk, notFound } = require('../helpers/mock.js');

const PASS = { supported: true, valid: true, status: 'valid', blockIndex: 42 };

function legacyExplorer(answer = PASS, { withPreflight = true } = {}) {
    const explorer = { getFeeQuote: async () => answer };
    if (withPreflight) explorer.getPreflight = async () => notFound();
    return explorer;
}

function tier1On(network, feeMode, explorer = legacyExplorer()) {
    const sdk = { config: { network }, explorer };
    const parsed = parse('SEND|0|JDOG|1|addr', { validate: false });
    return runTier1({ sdk, parsed, source: 's', timeoutMs: 1000, ...(feeMode ? { feeMode } : {}) });
}

describe('pre-flight Tier 1 /feequote fallback and the fee mode', function () {
    it('is a verdict when the caller states native fee mode', async function () {
        const out = await tier1On('bitcoin-regtest', 'native');
        expect(out.kind).to.equal('verdict');
        expect(out.valid).to.equal(true);
    });

    it('is a verdict on a native-only chain with no stated mode', async function () {
        for (const network of ['litecoin-regtest', 'dogecoin-mainnet'])
            expect((await tier1On(network)).kind, network).to.equal('verdict');
    });

    it('is a no-verdict in XCHAIN mode, stated or by the Bitcoin default', async function () {
        for (const [network, feeMode] of [['bitcoin-regtest', 'xchain'], ['bitcoin-regtest', undefined],
            ['litecoin-regtest', 'xchain'], ['bitcoin-mainnet', undefined]]) {
            const out = await tier1On(network, feeMode);
            expect(out.kind, network + ' ' + feeMode).to.equal('no-verdict');
            expect(out.reason).to.match(/native fee mode only/);
            expect(out.quote.blockIndex, 'the quote still carries its height').to.equal(42);
        }
    });

    it('is a no-verdict for an invalid answer too, since that was judged in the wrong mode', async function () {
        const out = await tier1On('bitcoin-regtest', undefined, legacyExplorer({ supported: true, valid: false, status: 'x' }));
        expect(out.kind).to.equal('no-verdict');
    });

    it('applies when the explorer has no getPreflight method at all', async function () {
        const out = await tier1On('bitcoin-regtest', undefined, legacyExplorer(PASS, { withPreflight: false }));
        expect(out.kind).to.equal('no-verdict');
    });

    it('is a no-verdict on an unknown chain with no stated mode', async function () {
        expect((await tier1On('unknown-net')).kind).to.equal('no-verdict');
    });

    it('keeps the earlier non-verdict reasons for a fallback reply', async function () {
        for (const [answer, reason] of [[{ supported: true, valid: true, feeExempt: true }, 'feeExempt'],
            [{ supported: false, status: 'FEE_QUOTE_CONTROLLER_UNSUPPORTED' }, 'guardInert'],
            [{ supported: false }, 'unsupported']])
            expect((await tier1On('bitcoin-regtest', undefined, legacyExplorer(answer))).reason).to.equal(reason);
    });

    it('a /preflight verdict on Bitcoin is untouched', async function () {
        const out = await tier1On('bitcoin-regtest', undefined, { getPreflight: async () => PASS });
        expect(out.kind).to.equal('verdict');
    });
});

describe('pre-flight engine with a /feequote-only explorer on Bitcoin', function () {
    it('keeps a Tier-2 error standing and discloses the missing verdict', async function () {
        const sdk = mockSdk({ explorerSpec: {
            getToken: () => notFound(),
            getBalances: () => [],
            getPreflight: () => notFound(),
            getFeeQuote: () => PASS,
        } });
        const r = await sdk.preflight('SEND|0|MISSING|1|addr', { source: 's', preflight: 'report' });
        const tokenFinding = r.findings.find(f => f.code === 'TOKEN_NOT_FOUND');
        expect(tokenFinding.severity).to.equal('error');
        expect(r.verdict).to.equal('fail');
        expect(r.findings.some(f => f.code === 'DRYRUN_VALID')).to.equal(false);
        expect(r.findings.some(f => f.code === 'DRYRUN_UNAVAILABLE')).to.equal(true);
    });
});
