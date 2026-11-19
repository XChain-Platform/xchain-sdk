'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { parse } = require('../../../src/decoder/parse.js');
const { mockSdk } = require('./helpers/mock.js');

const DEST = 'mxNAZQtCRBG3dYu2ufVxSsc7V3c8jh9HDM';
const OPTS = { source: 's', preflight: 'report' };

// Every Tier-2 token lookup names the tick it was asked about, so the list of ticks
// seen is the list of producers that ran (one per distinct shared report).
function tokenSdk() {
    const seen = [];
    const sdk = mockSdk({ explorerSpec: {
        getFeeQuote: () => ({ feeExempt: true }),
        getToken: async (tick) => {
            seen.push(String(tick));
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { info: { tick: String(tick) }, decimals: 8 };
        },
        getBalances: () => [],
    } });
    return { sdk, seen };
}

// A ParsedAction another caller built: the string names one tick and the params another.
const handBuilt = (tick, actionString) => {
    const p = parse(`SEND|0|${tick}|1|${DEST}`);
    return Object.assign({}, p, actionString === undefined ? {} : { actionString });
};

describe('pre-flight coalescing of a caller-built ParsedAction', function () {
    it('two ParsedActions sharing an actionString but not params run separate producers', async function () {
        const { sdk, seen } = tokenSdk();
        const a = handBuilt('AAA', 'SEND|0|SHARED|1|' + DEST);
        const b = handBuilt('BBB', 'SEND|0|SHARED|1|' + DEST);
        await Promise.all([sdk.preflight(a, OPTS), sdk.preflight(b, OPTS)]);
        expect([...new Set(seen)].sort()).to.deep.equal(['AAA', 'BBB']);
    });

    it('ParsedActions with no actionString and different params do not share a report', async function () {
        const { sdk, seen } = tokenSdk();
        const a = handBuilt('AAA'); delete a.actionString;
        const b = handBuilt('BBB'); delete b.actionString;
        const [ra, rb] = await Promise.all([sdk.preflight(a, OPTS), sdk.preflight(b, OPTS)]);
        expect(ra).to.not.equal(rb);
        expect([...new Set(seen)].sort()).to.deep.equal(['AAA', 'BBB']);
    });

    it('control: identical ParsedActions still coalesce onto one producer', async function () {
        const { sdk, seen } = tokenSdk();
        const [a, b] = await Promise.all([
            sdk.preflight(parse(`SEND|0|AAA|1|${DEST}`), OPTS),
            sdk.preflight(parse(`SEND|0|AAA|1|${DEST}`), OPTS),
        ]);
        expect(a).to.equal(b);
        expect(seen.filter((t) => t === 'AAA')).to.have.lengthOf(1);
    });

    it('control: a pair of identical raw strings still coalesces', async function () {
        const { sdk, seen } = tokenSdk();
        const wire = `SEND|0|AAA|1|${DEST}`;
        const [a, b] = await Promise.all([sdk.preflight(wire, OPTS), sdk.preflight(wire, OPTS)]);
        expect(a).to.equal(b);
        expect(seen.filter((t) => t === 'AAA')).to.have.lengthOf(1);
    });

    it('a ParsedAction that cannot be serialized is checked, never coalesced and never thrown on', async function () {
        const { sdk } = tokenSdk();
        const circular = handBuilt('AAA');
        circular.params = Object.assign({}, circular.params);
        circular.params.self = circular.params;
        const first = sdk.preflight(circular, OPTS).catch((e) => e);
        const second = sdk.preflight(circular, OPTS).catch((e) => e);
        const [a, b] = await Promise.all([first, second]);
        expect(a).to.not.equal(b);
    });
});
