/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * Unit: chunkHelper — the chunked-DEPLOY planner.
 *
 * chunkHelper produces the deterministic base64 slices + CODE_HASH that the whole
 * chunked-deploy feature rests on. It is consensus-adjacent: codeHashOf MUST equal
 * the indexer's sha256(utf8(source)), and the slices MUST reassemble to canonical
 * base64 of the source — otherwise the indexer rejects the assembly. These tests
 * pin that behavior AND replay the indexer's exact assembly+verify against the plan
 * output (deploy.js: concat → base64-decode → canonical check → sha256 vs CODE_HASH),
 * so an SDK-side regression that would fork the deploy is caught here, runnably,
 * without the live stack.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const crypto = require('crypto');
const chunkHelper = require('../../src/chunkHelper.js');

const { codeHashOf, fitsSingleDeploy, splitCode, planDeploy,
        MAX_ACTION_DATA_LENGTH, MAX_DEPLOYCHUNK_PART_BYTES, MAX_DEPLOY_CHUNKS } = chunkHelper;

// Replays the indexer's chunk-assembly integrity gate (xchain-indexer
// src/actions/deploy.js) so a parity break surfaces SDK-side. Returns the
// decoded source on success, or throws with the indexer's rejection reason.
function indexerAssemble(parts, declaredHash) {
    const b64 = parts.join('');
    const code = Buffer.from(b64, 'base64').toString('utf8');
    if (Buffer.from(code, 'utf8').toString('base64') !== b64)
        throw new Error('CODE_HASH (base64 decode failed)');           // non-canonical base64
    const assembledHash = crypto.createHash('sha256').update(code).digest('hex');
    if (assembledHash !== declaredHash)
        throw new Error('CODE_HASH (assembly mismatch)');
    return code;
}

const SMALL = 'module.exports={ping:function(){return "ok";}};';
// base64 of the source must exceed a single action's budget to force chunking.
const MID   = 'var PAD="' + 'x'.repeat(12000) + '";module.exports={f:function(){return PAD.length;}};';
// base64 of the source must exceed MAX_DEPLOY_CHUNKS * MAX_DEPLOYCHUNK_PART_BYTES.
const HUGE  = 'var PAD="' + 'x'.repeat(100000) + '";module.exports={};';

describe('chunkHelper @regression', function () {

    // Canonical-value pins (mirrors the decoder's "should equal 8192 (protocol canonical
    // value)" guard). These constants are duplicated from xchain-documentation/protocol/
    // constants.js; the decoder + encoder pin their own copies the same way, so a drift in
    // any one service is caught review-side without a brittle cross-repo require.
    describe('canonical constants', function () {
        it('MAX_ACTION_DATA_LENGTH === 8192', function () {
            expect(MAX_ACTION_DATA_LENGTH).to.equal(8192);
        });
        it('MAX_DEPLOYCHUNK_PART_BYTES === 7800', function () {
            expect(MAX_DEPLOYCHUNK_PART_BYTES).to.equal(7800);
        });
        it('MAX_DEPLOY_CHUNKS === 16', function () {
            expect(MAX_DEPLOY_CHUNKS).to.equal(16);
        });
    });

    describe('codeHashOf', function () {
        it('is sha256 of the UTF-8 source (indexer parity: crypto.sha256(code))', function () {
            const expected = crypto.createHash('sha256').update(Buffer.from(SMALL, 'utf8')).digest('hex');
            expect(codeHashOf(SMALL)).to.equal(expected);
        });
        it('is a 64-char lowercase hex digest', function () {
            expect(codeHashOf(MID)).to.match(/^[0-9a-f]{64}$/);
        });
        it('is deterministic (same source → same hash)', function () {
            expect(codeHashOf(MID)).to.equal(codeHashOf(MID));
        });
        it('handles multi-byte UTF-8 source (hashes the bytes, not code units)', function () {
            const uni = 'module.exports={s:"snowman ☃ café 𝟙"};';
            const expected = crypto.createHash('sha256').update(Buffer.from(uni, 'utf8')).digest('hex');
            expect(codeHashOf(uni)).to.equal(expected);
        });
    });

    describe('fitsSingleDeploy', function () {
        it('true for a small contract', function () {
            expect(fitsSingleDeploy(SMALL, { gasLimit: 100000 })).to.equal(true);
        });
        it('false when base64(code) + overhead exceeds the action cap', function () {
            expect(fitsSingleDeploy(MID, { gasLimit: 100000 })).to.equal(false);
        });
        it('accounts for constructorParams overhead in the budget', function () {
            // A source sized to fit only when the constructor field is empty: adding a
            // large ctor string must push it over the single-action cap.
            const budget = MAX_ACTION_DATA_LENGTH;
            // pick a source whose base64 leaves ~40 bytes of headroom under the cap
            let srcBytes = Math.floor((budget - 60) * 3 / 4) - 32;
            const borderline = 'x'.repeat(srcBytes);
            expect(fitsSingleDeploy(borderline, { gasLimit: 0 }),
                'fits with no constructor params').to.equal(true);
            expect(fitsSingleDeploy(borderline, { gasLimit: 0, constructorParams: ['y'.repeat(200)] }),
                'a long constructor pushes the same source over the cap').to.equal(false);
        });
    });

    describe('splitCode', function () {
        it('every slice is within MAX_DEPLOYCHUNK_PART_BYTES', function () {
            for (const part of splitCode(HUGE))
                expect(Buffer.byteLength(part, 'utf8')).to.be.at.most(MAX_DEPLOYCHUNK_PART_BYTES);
        });
        it('concatenation in order restores base64(code) exactly', function () {
            const b64 = Buffer.from(MID, 'utf8').toString('base64');
            expect(splitCode(MID).join('')).to.equal(b64);
        });
        it('round-trips: decode(join(slices)) === original source', function () {
            const decoded = Buffer.from(splitCode(MID).join(''), 'base64').toString('utf8');
            expect(decoded).to.equal(MID);
        });
        it('empty source yields a single empty slice (edge)', function () {
            expect(splitCode('')).to.deep.equal(['']);
        });
    });

    describe('planDeploy', function () {
        it('single-shot for a small contract (no chunks)', function () {
            const plan = planDeploy(SMALL, { gasLimit: 100000 });
            expect(plan.single).to.equal(true);
            expect(plan.parts).to.equal(null);
            expect(plan.totalChunks).to.equal(0);
            expect(plan.codeHash).to.equal(codeHashOf(SMALL));
        });

        it('chunked for an oversized contract; totalChunks === parts.length', function () {
            const plan = planDeploy(MID, { gasLimit: 100000 });
            expect(plan.single).to.equal(false);
            expect(plan.parts).to.be.an('array').with.length.greaterThan(1);
            expect(plan.totalChunks).to.equal(plan.parts.length);
            expect(plan.codeHash).to.equal(codeHashOf(MID));
        });

        it('is deterministic — identical parts + hash across calls', function () {
            const a = planDeploy(MID, { gasLimit: 100000 });
            const b = planDeploy(MID, { gasLimit: 100000 });
            expect(a.codeHash).to.equal(b.codeHash);
            expect(a.parts).to.deep.equal(b.parts);
        });

        it('throws when the source needs more than MAX_DEPLOY_CHUNKS slices', function () {
            expect(() => planDeploy(HUGE, { gasLimit: 100000 })).to.throw(/MAX_DEPLOY_CHUNKS/);
        });

        // ── The headline: the plan's slices pass the indexer's exact integrity gate ──
        it('plan output passes the indexer assembly+verify (SDK↔indexer parity)', function () {
            const plan = planDeploy(MID, { gasLimit: 100000 });
            // The indexer concats the v4 carriers in chunk order, base64-decodes, rejects
            // non-canonical base64, then requires sha256(decoded) === CODE_HASH.
            const assembled = indexerAssemble(plan.parts, plan.codeHash);
            expect(assembled, 'reassembled source is byte-exact').to.equal(MID);
        });

        it('a reordered slice breaks the indexer integrity gate (proves order matters)', function () {
            const plan = planDeploy(MID, { gasLimit: 100000 });
            const swapped = plan.parts.slice();
            [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
            expect(() => indexerAssemble(swapped, plan.codeHash)).to.throw(/CODE_HASH/);
        });
    });

    // ── Size invariants: the constants must keep chunked deploy encodable + capable ──
    // These constants are duplicated across docs/constants.js, the decoder, the encoder
    // and here; if MAX_DEPLOYCHUNK_PART_BYTES is bumped past the action cap, every v4
    // carrier fails to encode, and if the chunk budget shrinks below base64(MAX_CODE_SIZE)
    // a maximum-size contract can no longer be chunked. Pin both relationships.
    describe('size invariants', function () {
        const OP_PUSHDATA2_OVERHEAD = 3; // matches chunkHelper's internal OP_RETURN_PUSH_OVERHEAD
        const MAX_CODE_SIZE = 65536;     // 64 KB decoded-source cap (indexer DEPLOY limit)

        it('a maximal v4 carrier (full part + worst-case fields) fits one action', function () {
            // Worst-case wire string: DEPLOY|4|<64-hash>|<idx>|<total>|<full base64 part>
            const carrier = ['DEPLOY', '4', 'f'.repeat(64), String(MAX_DEPLOY_CHUNKS - 1),
                String(MAX_DEPLOY_CHUNKS), 'p'.repeat(MAX_DEPLOYCHUNK_PART_BYTES)].join('|');
            expect(Buffer.byteLength(carrier, 'utf8') + OP_PUSHDATA2_OVERHEAD).to.be.at.most(
                MAX_ACTION_DATA_LENGTH,
                'a full v4 carrier incl. push overhead must fit one action — else every chunked deploy fails to encode');
        });

        it('MAX_DEPLOY_CHUNKS slices can carry a maximum-size (64 KB) contract', function () {
            const b64Len = Math.ceil(MAX_CODE_SIZE / 3) * 4; // base64 length of MAX_CODE_SIZE bytes
            expect(MAX_DEPLOY_CHUNKS * MAX_DEPLOYCHUNK_PART_BYTES).to.be.at.least(
                b64Len,
                'the chunk budget must cover base64(MAX_CODE_SIZE) or a max-size contract cannot be chunked');
        });
    });
});
