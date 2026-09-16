'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, reportFor } = require('./helpers/setup.js');

/*
 * INDEXER-MAP's cost-weight budget entry, mirrored from the arbiter
 * once its remaining weight classes landed.
 *
 * The posture is the point and is asserted, not assumed: this is a WARNING in
 * both cases. The rule is live on testnet and regtest from genesis and UNARMED
 * on mainnet, pre-flight has no chain height to tell them apart, and this
 * module's doctrine is that the mirror may accept a batch the chain rejects,
 * never the reverse. A refusal here would false-block legal mainnet work.
 */
const capFinding = (r) => r.findings.filter(f => f.code === 'BATCH_LIMIT_EXCEEDED'
    && f.data && f.data.action === 'COMMAND');
const money = { getToken: () => null, getBalances: () => [{ tick: 'XCHAIN', amount: '9999999' }] };
const batchOf = (cmd, n) => 'BATCH|0|' + Array.from({ length: n }, () => cmd).join(';');

describe('pre-flight BATCH cost-weight budget', function () {

    it('eleven AIRDROPs weigh 275 and are reported, far under the command cap', async function () {
        const r = await reportFor(batchOf('AIRDROP|0|1', 11), money);
        const caps = capFinding(r);
        expect(caps).to.have.length(1);
        expect(caps[0].data.weight).to.equal(275);
        expect(caps[0].data.limit).to.equal(250);
        expect(caps[0].data.count).to.equal(11);
        // The whole reason the mirror was owed: counting commands cannot see this.
        expect(caps[0].data.count).to.be.below(250);
    });

    it('ten AIRDROPs weigh exactly 250 and are NOT reported', async function () {
        const r = await reportFor(batchOf('AIRDROP|0|1', 10), money);
        expect(capFinding(r)).to.have.length(0);
    });

    it('nine EXECUTEs weigh 270 and are reported', async function () {
        const r = await reportFor(batchOf('EXECUTE|0|x|1', 9), money);
        const caps = capFinding(r);
        expect(caps).to.have.length(1);
        expect(caps[0].data.weight).to.equal(270);
    });

    it('is a WARNING, never an error: pre-flight cannot resolve the including block', async function () {
        const r = await reportFor(batchOf('AIRDROP|0|1', 11), money);
        const caps = capFinding(r);
        expect(caps).to.have.length(1);
        expect(caps[0].severity).to.equal('warning');
    });

    it('two hundred ordinary commands weigh 200 and are NOT reported', async function () {
        // Default weight is 1, so an ordinary batch is decided arithmetically
        // identically to the count rule. MINT raises its own per-action finding
        // here; the assertion is only about the COMMAND cap.
        const r = await reportFor(batchOf('MINT|0|JDOG|1', 200), {
            getToken: () => ({ tick: 'JDOG', decimals: '0' }),
            getBalances: () => [{ tick: 'JDOG', amount: '9999999' }],
        });
        expect(capFinding(r)).to.have.length(0);
    });

    it('surfaces the cap once, not once per weighted command', async function () {
        const r = await reportFor(batchOf('AIRDROP|0|1', 20), money);
        expect(capFinding(r)).to.have.length(1);
    });

    it('reports the COUNT, not the weight, when the count is what overflowed', async function () {
        const wire = 'BATCH|0|' + Array.from({ length: 251 }, (_, i) => 'ISSUE|0|JDOG.' + i + '|1').join(';');
        const r = await reportFor(wire, money);
        const caps = capFinding(r);
        expect(caps).to.have.length(1);
        expect(caps[0].data.count).to.equal(251);
        expect(caps[0].data.limit).to.equal(250);
        expect(caps[0].data.weight).to.equal(undefined);
    });
});
