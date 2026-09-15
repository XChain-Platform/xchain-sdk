'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect, mockSdk, reportFor } = require('./helpers/setup.js');

// F7: the global command cap, surfaced once.
describe('pre-flight BATCH command cap', function () {

    const capFinding = (r) => r.findings.filter(f => f.code === 'BATCH_LIMIT_EXCEEDED'
        && f.data && f.data.action === 'COMMAND');

    it('251 commands raises exactly one cap finding', async function () {
        const wire = 'BATCH|0|' + Array.from({ length: 251 }, (_, i) => 'ISSUE|0|JDOG.' + i + '|1').join(';');
        const r = await reportFor(wire, { getToken: () => null, getBalances: () => [{ tick: 'XCHAIN', amount: '999' }] });
        const caps = capFinding(r);
        expect(caps).to.have.length(1);
        expect(caps[0].data.count).to.equal(251);
        expect(caps[0].data.limit).to.equal(250);
    });

    it('exactly 250 commands raises none', async function () {
        const wire = 'BATCH|0|' + Array.from({ length: 250 }, (_, i) => 'ISSUE|0|JDOG.' + i + '|1').join(';');
        const r = await reportFor(wire, { getToken: () => null, getBalances: () => [{ tick: 'XCHAIN', amount: '999' }] });
        expect(capFinding(r)).to.have.length(0);
    });

    it('the check owns the cap when the caller supplies a ParsedAction with no findings', async function () {
        // A pre-parsed input (validate:false) carries no validator findings, so
        // the decoder-side cap never reaches the report and checks/batch.js is
        // the only thing standing between the caller and a batch the chain
        // rejects wholesale.
        const { parse } = require('../../../../src/decoder/parse.js');
        const wire = 'BATCH|0|' + Array.from({ length: 251 }, (_, i) => 'ISSUE|0|JDOG.' + i + '|1').join(';');
        const parsed = parse(wire, { validate: false });
        expect(parsed.validation).to.equal(null);
        const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }),
            getToken: () => null, getBalances: () => [{ tick: 'XCHAIN', amount: '999' }] } });
        const r = await sdk.preflight(parsed, { source: 'me', preflight: 'report' });
        const caps = capFinding(r);
        expect(caps).to.have.length(1);
        expect(caps[0].data.count).to.equal(251);
    });
});
