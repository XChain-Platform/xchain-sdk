'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 * COINPAY per-payee output planning (spec row 31).
 *
 * xchain-indexer/src/actions/coinpay.js resolves each obligation's payment output
 * by FIRST MATCH on the payee address over the batch's vout-sorted output set
 * (findPaymentOutput), and every obligation naming the same payee draws on that
 * SAME output's pool (coinPayeeConsumed). A composer that pays one seller with TWO
 * outputs for two obligations therefore only ever gets credit against the FIRST one:
 * the second obligation reads the first output's remaining pool, not the second
 * output, and fails short if that pool cannot cover it alone.
 *
 * These vectors pin planCoinpayOutputs (derive the required output set) and
 * checkCoinpayOutputPlan (validate a planned output set) against that behaviour.
 ********************************************************************/

const { expect } = require('chai');
const { planCoinpayOutputs, checkCoinpayOutputPlan } = require('../../src/batchLimits.js');

describe('batchLimits: COINPAY per-payee output planning (spec row 31)', function(){

    describe('planCoinpayOutputs', function(){

        it('combines two obligations to the SAME payee into ONE output', function(){
            const plan = planCoinpayOutputs([
                { payee: 'sellerA', amount: '1.00000000' },
                { payee: 'sellerA', amount: '2.50000000' },
            ]);
            expect(plan).to.deep.equal([
                { payee: 'sellerA', amount: '3.5' },
            ]);
        });

        it('keeps two obligations to DIFFERENT payees as two separate outputs', function(){
            const plan = planCoinpayOutputs([
                { payee: 'sellerA', amount: '1' },
                { payee: 'sellerB', amount: '2' },
            ]);
            expect(plan).to.deep.equal([
                { payee: 'sellerA', amount: '1' },
                { payee: 'sellerB', amount: '2' },
            ]);
        });

        it('orders distinct payees by first appearance', function(){
            const plan = planCoinpayOutputs([
                { payee: 'sellerB', amount: '1' },
                { payee: 'sellerA', amount: '1' },
                { payee: 'sellerB', amount: '1' },
            ]);
            expect(plan.map(p => p.payee)).to.deep.equal(['sellerB', 'sellerA']);
            expect(plan.find(p => p.payee === 'sellerB').amount).to.equal('2');
        });

        it('ignores an obligation with no payee rather than throwing', function(){
            const plan = planCoinpayOutputs([
                { payee: 'sellerA', amount: '1' },
                { amount: '1' },
                null,
            ]);
            expect(plan).to.deep.equal([{ payee: 'sellerA', amount: '1' }]);
        });

    });

    describe('checkCoinpayOutputPlan', function(){

        it('FAILS a plan that splits one payee\'s combined amount across two outputs', function(){
            // Two obligations totalling 3.5 owed to sellerA, but the composer built
            // TWO outputs instead of one. findPaymentOutput only ever resolves the
            // FIRST (vout order = array order here), so the second obligation reads
            // the first output's remaining pool and finds it short.
            const result = checkCoinpayOutputPlan(
                [
                    { payee: 'sellerA', amount: '1.00000000' },
                    { payee: 'sellerA', amount: '2.50000000' },
                ],
                [
                    { address: 'sellerA', amount: '1.00000000' },
                    { address: 'sellerA', amount: '2.50000000' },
                ]
            );
            expect(result.ok).to.equal(false);
            expect(result.violations).to.deep.equal([{
                payee: 'sellerA',
                owed: '3.5',
                available: '1',
                reason: 'INSUFFICIENT',
            }]);
        });

        it('PASSES a plan that combines one payee\'s obligations into a single output', function(){
            const result = checkCoinpayOutputPlan(
                [
                    { payee: 'sellerA', amount: '1.00000000' },
                    { payee: 'sellerA', amount: '2.50000000' },
                ],
                [
                    { address: 'sellerA', amount: '3.50000000' },
                ]
            );
            expect(result.ok).to.equal(true);
            expect(result.violations).to.deep.equal([]);
        });

        it('PASSES two obligations to two DIFFERENT payees, each with its own output', function(){
            const result = checkCoinpayOutputPlan(
                [
                    { payee: 'sellerA', amount: '1' },
                    { payee: 'sellerB', amount: '2' },
                ],
                [
                    { address: 'sellerA', amount: '1' },
                    { address: 'sellerB', amount: '2' },
                ]
            );
            expect(result.ok).to.equal(true);
            expect(result.violations).to.deep.equal([]);
        });

        it('surplus above the owed amount stays in the payee\'s pool for a sibling obligation (R5b)', function(){
            // One output larger than either single obligation, covering BOTH when
            // combined: the first obligation draws 1, leaving 2 in the pool, which
            // covers the second obligation's 2 exactly (R5b: surplus above what is
            // owed stays in the pool rather than being consumed whole).
            const result = checkCoinpayOutputPlan(
                [
                    { payee: 'sellerA', amount: '1' },
                    { payee: 'sellerA', amount: '2' },
                ],
                [
                    { address: 'sellerA', amount: '3' },
                ]
            );
            expect(result.ok).to.equal(true);
            expect(result.violations).to.deep.equal([]);
        });

        it('FAILS with NO_OUTPUT when no output pays the obligation\'s payee at all', function(){
            const result = checkCoinpayOutputPlan(
                [{ payee: 'sellerA', amount: '1' }],
                [{ address: 'sellerB', amount: '1' }]
            );
            expect(result.ok).to.equal(false);
            expect(result.violations).to.deep.equal([{
                payee: 'sellerA',
                owed: '1',
                available: '0',
                reason: 'NO_OUTPUT',
            }]);
        });

        it('resolves the FIRST matching output only, identical to findPaymentOutput, even when a LATER output would have been enough alone', function(){
            // sellerA's first output pays only 0.5, short of the 3.5 owed even though
            // a second output paying 5 sits right after it. The real handler never
            // looks past the first match, so neither does this check.
            const result = checkCoinpayOutputPlan(
                [
                    { payee: 'sellerA', amount: '1' },
                    { payee: 'sellerA', amount: '2.5' },
                ],
                [
                    { address: 'sellerA', amount: '0.5' },
                    { address: 'sellerA', amount: '5' },
                ]
            );
            expect(result.ok).to.equal(false);
            expect(result.violations).to.deep.equal([{
                payee: 'sellerA',
                owed: '3.5',
                available: '0.5',
                reason: 'INSUFFICIENT',
            }]);
        });

    });

});
