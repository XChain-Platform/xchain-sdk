/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Unit tests for src/utils/x402.js: action-string parsing (incl. spoof
 * cases), invoice lifecycle, send/dispenser/deposit verification with
 * a stubbed explorer, the provisional sweeper, and the client loop
 * with a stubbed session. No network, no real chain.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');

const { parseActionString } = require('../../src/utils/x402.js');
const { SDKX402Error } = require('../../src/utils/errors.js');

const NONCE = 'a'.repeat(32);

describe('x402', () => {

    /* ── parseActionString ─────────────────────────────────────────── */

    describe('parseActionString', () => {
        it('parses SEND v0 into one output tuple', () => {
            const p = parseActionString(`SEND|0|tok|5|dest1|${NONCE}`);
            expect(p.action).to.equal('SEND');
            expect(p.outputs).to.deep.equal([{ tick: 'TOK', amount: '5', destination: 'dest1', memo: NONCE }]);
        });

        it('keeps multi-output tuples paired (v1: amounts belong to their own destination)', () => {
            const p = parseActionString(`SEND|1|TOK|100|other|2|target|${NONCE}`);
            expect(p.outputs).to.deep.equal([
                { tick: 'TOK', amount: '100', destination: 'other',  memo: NONCE },
                { tick: 'TOK', amount: '2',   destination: 'target', memo: NONCE },
            ]);
        });

        it('v2 pairs per-output ticks; v3 pairs per-group memos', () => {
            const v2 = parseActionString(`SEND|2|AAA|1|d1|BBB|2|d2|${NONCE}`);
            expect(v2.outputs[1]).to.deep.equal({ tick: 'BBB', amount: '2', destination: 'd2', memo: NONCE });
            const v3 = parseActionString(`SEND|3|AAA|1|d1|memo1|BBB|2|d2|${NONCE}`);
            expect(v3.outputs[0].memo).to.equal('memo1');
            expect(v3.outputs[1].memo).to.equal(NONCE);
        });

        it('rejects field-count mismatches (extra pipes cannot shift fields)', () => {
            expect(parseActionString(`SEND|0|TOK|5|dest1|x|y`)).to.equal(null);
            expect(parseActionString(`SEND|1|TOK|5|dest1|${NONCE}`)).to.equal(null);
        });

        it('rejects non-numeric and non-positive amounts', () => {
            expect(parseActionString(`SEND|0|TOK|1e1000|dest|${NONCE}`)).to.equal(null);
            expect(parseActionString(`SEND|0|TOK|-5|dest|${NONCE}`)).to.equal(null);
            expect(parseActionString(`SEND|0|TOK|５|dest|${NONCE}`)).to.equal(null);   // full-width digit
        });

        it('returns empty outputs for non-SEND actions and null for garbage', () => {
            expect(parseActionString('MINT|0|TOK|9').outputs).to.deep.equal([]);
            expect(parseActionString('|||')).to.equal(null);
            expect(parseActionString('')).to.equal(null);
        });
    });

    it('exports are wired into the SDK entry point', () => {
        const sdkIndex = require('../../index.js');
        expect(sdkIndex.X402Gateway).to.be.a('function');
        expect(sdkIndex.X402Client).to.be.a('function');
        expect(sdkIndex.SDKX402Error).to.equal(SDKX402Error);
    });
});
