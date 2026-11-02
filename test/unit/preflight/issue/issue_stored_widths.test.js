'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { mockSdk, notFound } = require('../helpers/mock.js');
const { STORED_TEXT_WIDTHS, MIN_DEPTH_MAX_CHARS } = require('../../../../src/preflight/checks/issue/stored_widths.js');

// An ISSUE wire value wider than the issues column that stores it is refused from genesis
// (xchain-indexer src/actions/issue/token_state.js storedWidthError, and the MIN_DEPTH
// width rule in issue/bridge_opt_in.js). Before those rules the INSERT failed and the
// block retried forever, so pre-flight refuses each as a non-overridable error.
const FORMAT_0 = ('TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|'
    + 'LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|'
    + 'CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|LOCK_MINT|'
    + 'LOCK_MINT_SUPPLY|MEMO').split('|');
const issue0 = (over) => 'ISSUE|0|' + FORMAT_0.map((name) => (name in over ? over[name]
    : ({ TICK: 'JDOGX', MAX_SUPPLY: '1000', MAX_MINT: '10', DECIMALS: '0' })[name] || '')).join('|');
const issue7 = (chains, depth, lock) => `ISSUE|7|JDOGX|${chains}|${depth}|${lock}`;
const padded = (width, digit) => '0'.repeat(width - 1) + digit;

const existing = () => ({ info: { tick: 'JDOGX', owner: 'me', decimals: 0, tick_id: 9 } });
async function reportFor(wire, getToken = existing) {
    const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), getToken } });
    sdk.explorer.coin = 'RBTC';
    return sdk.preflight(wire, { source: 'me', preflight: 'report' });
}
const widthFindings = (r, field) => r.findings.filter((f) => f.code === 'VALIDATOR_SEMANTICS'
    && f.severity === 'error' && f.data && f.data.field === field && f.data.limit !== undefined);

async function expectRefused(wire, field, width, verdict, getToken) {
    const found = widthFindings(await reportFor(wire, getToken), field);
    expect(found, field).to.have.length(1);
    expect(found[0].overridable).to.equal(false);
    expect(found[0].message).to.include(verdict);
    expect(found[0].data).to.include({ width, verdict, haltClass: true });
}
async function expectClear(wire, field, getToken) {
    expect(widthFindings(await reportFor(wire, getToken), field), field).to.deep.equal([]);
}

function registerFormatZeroWidths() {
    it('pins the column widths the indexer checks', function () {
        expect(STORED_TEXT_WIDTHS).to.deep.equal({ DECIMALS: 2, CALLBACK_BLOCK: 15, MINT_START_BLOCK: 15,
            MINT_STOP_BLOCK: 15, BRIDGE_CHAINS: 250, LOCK_BRIDGE: 1 });
        expect(MIN_DEPTH_MAX_CHARS).to.equal(15);
    });

    it('refuses a 3-character DECIMALS and keeps a 2-character one', async function () {
        await expectRefused(issue0({ DECIMALS: '001' }), 'DECIMALS', 3, 'invalid: DECIMALS (length)', notFound);
        await expectClear(issue0({ DECIMALS: '01' }), 'DECIMALS', notFound);
        await expectClear(issue0({ DECIMALS: '18' }), 'DECIMALS', notFound);
    });

    it('measures DECIMALS only where the indexer stores it', async function () {
        // Out of range or non-numeric, the writer stores NULL, so no width verdict follows.
        await expectClear(issue0({ DECIMALS: '019' }), 'DECIMALS', notFound);
        await expectClear(issue0({ DECIMALS: 'abc' }), 'DECIMALS', notFound);
    });

    for (const field of ['CALLBACK_BLOCK', 'MINT_START_BLOCK', 'MINT_STOP_BLOCK']) {
        it(`refuses a 16-character ${field} and keeps a 15-character one`, async function () {
            await expectRefused(issue0({ [field]: padded(16, 5) }), field, 16, `invalid: ${field} (length)`);
            await expectRefused(issue0({ [field]: '1' + '0'.repeat(15) }), field, 16, `invalid: ${field} (length)`);
            await expectClear(issue0({ [field]: padded(15, 5) }), field);
            await expectClear(issue0({ [field]: '9'.repeat(15) }), field);
        });

        it(`leaves a ${field} past the u64 ceiling to the integer rule, which stores it as NULL`, async function () {
            await expectClear(issue0({ [field]: '18446744073709551616' }), field);
        });
    }
}

function registerFormatSevenWidths() {
    it('refuses a 251-character BRIDGE_CHAINS and keeps a 250-character one', async function () {
        const wide = Array(63).fill('LTC').join(',');
        const fits = Array(59).fill('LTC').concat(['DOGE', 'DOGE', 'DOGE']).join(',');
        expect([wide.length, fits.length]).to.deep.equal([251, 250]);
        await expectRefused(issue7(wide, '', ''), 'BRIDGE_CHAINS', 251, 'invalid: BRIDGE_CHAINS (length)');
        await expectClear(issue7(fits, '', ''), 'BRIDGE_CHAINS');
    });

    it('refuses a 2-character LOCK_BRIDGE that the 0/1 rule accepts', async function () {
        await expectRefused(issue7('LTC', '', '01'), 'LOCK_BRIDGE', 2, 'invalid: LOCK_BRIDGE (length)');
        await expectClear(issue7('LTC', '', '1'), 'LOCK_BRIDGE');
        await expectClear(issue7('LTC', '', '0'), 'LOCK_BRIDGE');
    });

    it('refuses a 16-digit MIN_DEPTH as MIN_DEPTH (format) and keeps a 15-digit one', async function () {
        await expectRefused(issue7('LTC', padded(16, 6), ''), 'MIN_DEPTH', 16, 'invalid: MIN_DEPTH (format)');
        await expectClear(issue7('LTC', '9'.repeat(15), ''), 'MIN_DEPTH');
    });

    it('leaves a non-digit MIN_DEPTH to the digits rule alone', async function () {
        const r = await reportFor(issue7('LTC', 'x'.repeat(16), ''));
        expect(widthFindings(r, 'MIN_DEPTH')).to.deep.equal([]);
        expect(r.findings.some((f) => f.severity === 'error' && f.data && f.data.field === 'MIN_DEPTH')).to.equal(true);
    });

    it('judges the widths even when the token lookup is down', async function () {
        const down = () => { throw new Error('lookup unavailable'); };
        await expectRefused(issue7('LTC', padded(16, 6), '01'), 'LOCK_BRIDGE', 2, 'invalid: LOCK_BRIDGE (length)', down);
        await expectRefused(issue0({ MINT_START_BLOCK: padded(16, 5) }), 'MINT_START_BLOCK', 16,
            'invalid: MINT_START_BLOCK (length)', down);
    });
}

describe('ISSUE pre-flight: wire values wider than their issues column', function () {
    registerFormatZeroWidths();
    registerFormatSevenWidths();
});
