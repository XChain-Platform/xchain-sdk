'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * decoder.parse reads a wire string the way the indexer reads it: the
 * VERSION token through getFormatVersion, the legacy versionless
 * ISSUE/MINT/SEND, segments past a fixed format ignored, every value trimmed,
 * VERSION handed to the validator, and user-protection guards kept out of the
 * verdict. Each expectation is the indexer's verdict on the same string.
 *
 ********************************************************************/

const { expect } = require('chai');
const { parse } = require('../../../src/decoder/parse.js');
const config  = require('../../../src/config.js');
const Utility = require('../../../src/utils/utility.js');
const Actions = require('../../../src/actions/index.js');

const A1 = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';
const A2 = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';

const valid = (wire) => {
    const r = parse(wire);
    return r.ok === true && r.validation.ok === true;
};

describe('decoder reads VERSION tokens as the indexer does', function () {
    it('reads every numeric spelling of 0 as VERSION 0 and canonicalizes it', function () {
        for (const token of ['0', '00', '+0', '-0', ' 0 ']) {
            const r = parse('SEND|' + token + '|TEST|1|' + A1);
            expect([r.ok, r.version, r.validation && r.validation.ok], token).to.deep.equal([true, 0, true]);
            expect(r.actionString, token).to.equal('SEND|0|TEST|1|' + A1);
        }
    });

    it('strips quotes from a token outside the legacy shift, and shifts a quoted one inside it', function () {
        expect(parse('BROADCAST|"0"|hi').version).to.equal(0);
        // Three characters, so the indexer reads SEND's token as a legacy TICK.
        const r = parse('SEND|"0"|TEST|1|' + A1);
        expect([r.version, r.legacyVersion, r.params.TICK]).to.deep.equal([0, true, '"0"']);
    });

    it('reads ISSUE|01 as VERSION 1', function () {
        const r = parse('ISSUE|01|TEST|d');
        expect([r.version, r.validation.ok]).to.deep.equal([1, true]);
    });

    it('reads a legacy versionless SEND and MINT as VERSION 0', function () {
        for (const wire of ['SEND|TEST|1|' + A1, 'MINT|TEST|5']) {
            const r = parse(wire);
            expect([r.ok, r.version, r.legacyVersion, r.validation.ok], wire).to.deep.equal([true, 0, true, true]);
        }
        expect(parse('MINT|TEST|5').actionString).to.equal('MINT|0|TEST|5');
    });
});

describe('decoder ignores what the indexer ignores', function () {
    it('ignores segments past a fixed format and reports them', function () {
        for (const extra of ['|EXTRA', '|EXTRA|MORE', '|']) {
            const r = parse('SEND|0|TEST|1|' + A1 + '|m' + extra);
            expect([r.ok, r.validation.ok], extra).to.deep.equal([true, true]);
            expect(r.params.MEMO).to.equal('m');
            expect(r.actionString).to.equal('SEND|0|TEST|1|' + A1 + '|m');
        }
    });

    it('trims every value before reading it', function () {
        const r = parse('SEND|0| TEST |1| ' + A1 + ' | m ');
        expect(r.params).to.deep.equal({ TICK: 'TEST', AMOUNT: '1', DESTINATION: A1, MEMO: 'm' });
        expect(parse('PRICE|1|BTC|TEST|USD| 1.5').validation.ok).to.equal(true);
    });
});

describe('decoder validates with the VERSION it read', function () {
    function composed(action, params) {
        const actions = new Actions({ config: config.getConfig(), util: new Utility(), options: { network: 'bitcoin-regtest' } });
        return actions.composeActionString({ action, params }).actionString;
    }

    it('accepts LIST v2, LIST v3 and DEPLOY v4 strings the SDK itself composed', function () {
        const wires = [
            composed('LIST', { VERSION: '2', LIST_ACTION_INDEX: '5', MEMO: 'm' }),
            composed('LIST', { VERSION: '3', LIST_ACTION_INDEX: '5', DESTINATION: A2, MEMO: 'm' }),
            composed('DEPLOY', { VERSION: '4', CODE_HASH: 'ab'.repeat(32), CHUNK_INDEX: '0', TOTAL_CHUNKS: '2', CODE_PART: 'YWJj' }),
        ];
        for (const wire of wires) {
            const r = parse(wire);
            expect(r.validation.findings, wire).to.deep.equal([]);
        }
    });
});

describe('decoder verdicts on free text and size', function () {
    it('refuses a MEMO over 250 UTF-16 code units, as the indexer does', function () {
        expect(valid('SEND|0|TEST|1|' + A1 + '|' + 'a'.repeat(250))).to.equal(true);
        expect(valid('SEND|0|TEST|1|' + A1 + '|' + 'a'.repeat(251))).to.equal(false);
        expect(valid('SEND|0|TEST|1|' + A1 + '|' + '\u{1F600}'.repeat(126))).to.equal(false);
    });

    it('accepts the bytes a lone surrogate leaves on the wire (U+FFFD)', function () {
        const r = parse(Buffer.from('SEND|0|TEST|1|' + A1 + '|a\uD800b', 'utf8'));
        expect([r.validation.ok, r.params.MEMO]).to.deep.equal([true, 'a�b']);
    });

    it('measures a legacy carrier on the compiled push, as the on-chain decoder does', function () {
        const head = 'MESSAGE|3|BTC|' + A1 + '|';
        const wire = (n) => head + 'a'.repeat(n - head.length);
        expect(parse(wire(8189), { carrier: 'P2SH' }).ok).to.equal(true);
        for (const n of [8190, 8191, 8192])
            expect(parse(wire(n), { carrier: 'P2SH' }).code, String(n)).to.equal('TOO_LONG');
    });

    it('never refuses on size what the Taproot envelope stores', function () {
        const head = 'MESSAGE|3|BTC|' + A1 + '|';
        const r = parse(head + 'a'.repeat(20000), { carrier: 'TAPROOT' });
        expect([r.ok, r.validation.ok]).to.deep.equal([true, true]);
        const bare = parse(head + 'a'.repeat(20000));
        expect([bare.ok, bare.legacyCarrierFits]).to.deep.equal([true, false]);
    });
});

describe('decoder verdicts leave out compose-time guards', function () {
    it('accepts a zero amount the chain records valid, listing the guard apart', function () {
        const r = parse('SEND|0|TEST|0|' + A1);
        expect(r.validation.ok).to.equal(true);
        expect(r.validation.guards.map(g => g.details.field)).to.deep.equal(['AMOUNT']);
    });

    it('accepts an empty BROADCAST MESSAGE and an empty FILE NAME', function () {
        expect(valid('BROADCAST|0||1')).to.equal(true);
        expect(valid('FILE|0||text/plain')).to.equal(true);
    });

    it('keeps refusing what the chain refuses: an empty BATCH and a zero STAKE', function () {
        expect(parse('BATCH|0|').code).to.equal('EMPTY_BATCH');
        expect(valid('BATCH|0|SEND|0|TEST|1|' + A1 + ';')).to.equal(false);
        expect(valid('STAKE|1|0|' + 'ab'.repeat(32))).to.equal(false);
    });

    it('carries a guarded BATCH child into compose-time validation', function () {
        const actions = new Actions({ config: config.getConfig(), util: new Utility(), options: { network: 'bitcoin-regtest' } });
        expect(() => actions.composeActionString({ action: 'BATCH', params: { COMMAND: 'SEND|0|TEST|0|' + A1 } }))
            .to.throw(/positive/);
    });
});
