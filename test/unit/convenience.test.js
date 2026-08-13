/*
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 */

// Convenience methods and BatchBuilder tests: module entry point exports,
// convenience action methods on XChainSDK, and the BatchBuilder fluent API,
// validation, and independence.

'use strict';

const { expect } = require('chai');

const ADDR = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

describe('Module entry point', () => {

    it('exports XChainSDK', () => {
        const mod = require('../../index.js');
        expect(mod).to.have.property('XChainSDK');
        expect(mod.XChainSDK).to.be.a('function');
    });

    it('exports BatchBuilder', () => {
        const mod = require('../../index.js');
        expect(mod).to.have.property('BatchBuilder');
        expect(mod.BatchBuilder).to.be.a('function');
    });

    it('exports all error classes', () => {
        const mod = require('../../index.js');
        const errorClasses = [
            'SDKError',
            'SDKValidationError',
            'SDKFormatError',
            'SDKEncoderError',
            'SDKExplorerError',
            'SDKHubError',
            'SDKConfigError'
        ];
        for (let name of errorClasses) {
            expect(mod, `missing export: ${name}`).to.have.property(name);
            expect(mod[name]).to.be.a('function');
        }
    });

    it('new XChainSDK() constructs successfully from the entry point', () => {
        const { XChainSDK } = require('../../index.js');
        const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
        expect(sdk).to.be.an.instanceOf(XChainSDK);
    });

    it('default export equals XChainSDK', () => {
        const mod = require('../../index.js');
        expect(mod.default).to.equal(mod.XChainSDK);
    });

});

describe('Convenience action methods', () => {

    const { XChainSDK } = require('../../index.js');
    const sdk = new XChainSDK({ network: 'bitcoin-regtest' });

    // Helper: assert result has correct action name and a non-empty actionString
    function assertAction(result, expectedAction) {
        expect(result).to.be.an('object');
        expect(result.action).to.equal(expectedAction);
        expect(result.actionString).to.be.a('string').and.to.have.length.above(0);
    }

    it('send() returns action SEND with valid actionString', async () => {
        const result = await sdk.send({ tick: 'T', amount: '1', destination: ADDR });
        assertAction(result, 'SEND');
    });

    it('issue() returns action ISSUE with valid actionString', async () => {
        const result = await sdk.issue({ tick: 'T', description: 'test' });
        assertAction(result, 'ISSUE');
    });

    it('mint() returns action MINT with valid actionString', async () => {
        const result = await sdk.mint({ tick: 'T', amount: '1', destination: ADDR });
        assertAction(result, 'MINT');
    });

    it('destroy() returns action DESTROY with valid actionString', async () => {
        const result = await sdk.destroy({ tick: 'T', amount: '1' });
        assertAction(result, 'DESTROY');
    });

    it('order() returns action ORDER with valid actionString', async () => {
        const result = await sdk.order({ giveTick: 'A', giveAmount: '1', getTick: 'B', getAmount: '1' });
        assertAction(result, 'ORDER');
    });

    it('broadcast() returns action BROADCAST with valid actionString', async () => {
        const result = await sdk.broadcast({ message: 'hi', value: '1' });
        assertAction(result, 'BROADCAST');
    });

    it('dispenser() returns action DISPENSER with valid actionString', async () => {
        const result = await sdk.dispenser({
            giveTick: 'A', giveAmount: '1', giveEscrow: '1',
            getTick: 'B', getAmount: '1'
        });
        assertAction(result, 'DISPENSER');
    });

    it('dividend() returns action DIVIDEND with valid actionString', async () => {
        const result = await sdk.dividend({ tick: 'T', dividendTick: 'P', amount: '1' });
        assertAction(result, 'DIVIDEND');
    });

    it('sweep() returns action SWEEP with valid actionString', async () => {
        const result = await sdk.sweep({ destination: ADDR, balances: 1, ownerships: 1, orders: 0, swaps: 0, dispensers: 0 });
        assertAction(result, 'SWEEP');
    });

    it('swap() returns action SWAP with valid actionString', async () => {
        const result = await sdk.swap({ giveTick: 'A', giveAmount: '1', getTick: 'B', getAmount: '1' });
        assertAction(result, 'SWAP');
    });

    it('callback() returns action CALLBACK with valid actionString', async () => {
        const result = await sdk.callback({ tick: 'T' });
        assertAction(result, 'CALLBACK');
    });

    it('sleep() returns action SLEEP with valid actionString', async () => {
        const result = await sdk.sleep({ resumeBlock: 100 });
        assertAction(result, 'SLEEP');
    });

    it('airdrop() returns action AIRDROP with valid actionString', async () => {
        const result = await sdk.airdrop({ tick: 'T', amount: '1', listActionIndex: 1 });
        assertAction(result, 'AIRDROP');
    });

    it('message() returns action MESSAGE with valid actionString', async () => {
        const result = await sdk.message({ coin: 'BTC', destination: ADDR, plaintextMessage: 'hi' });
        assertAction(result, 'MESSAGE');
    });

    it('list() returns action LIST with valid actionString', async () => {
        const result = await sdk.list({ type: 1, item: 'T1' });
        assertAction(result, 'LIST');
    });

    it('link() returns action LINK with valid actionString', async () => {
        const result = await sdk.link({ coin1: 'BTC', coin1ActionIndex: 1, coin2: 'LTC', coin2ActionIndex: 2 });
        assertAction(result, 'LINK');
    });

    it('file() returns action FILE with valid actionString', async () => {
        const result = await sdk.file({ name: 'f', type: 1, title: 't' });
        assertAction(result, 'FILE');
    });

    it('address() returns action ADDRESS with valid actionString', async () => {
        const result = await sdk.address({ feePreference: 1 });
        assertAction(result, 'ADDRESS');
    });

    it('transfer() is an alias for send and returns action SEND', async () => {
        const result = await sdk.transfer({ tick: 'T', amount: '1', destination: ADDR });
        assertAction(result, 'SEND');
    });

});

describe('BatchBuilder', () => {

    const { XChainSDK, BatchBuilder, SDKValidationError } = require('../../index.js');
    const sdk = new XChainSDK({ network: 'bitcoin-regtest' });

    // A contract body only has to be valid base64 to serialize, so a DEPLOY
    // built from it fails or passes on the BATCH cap alone.
    const CONTRACT_B64 = Buffer.from('function main(){return 1}').toString('base64');

    // Basic building

    it('build() produces a BATCH action with semicolon-joined commands', async () => {
        const result = await sdk.batch()
            .send({ tick: 'T', amount: '1', destination: ADDR })
            .send({ tick: 'T', amount: '2', destination: ADDR })
            .build();
        expect(result.action).to.equal('BATCH');
        expect(result.actionString).to.include(';');
    });

    it('actionString starts with "BATCH|0|"', async () => {
        const result = await sdk.batch()
            .send({ tick: 'T', amount: '1', destination: ADDR })
            .build();
        expect(result.actionString).to.match(/^BATCH\|0\|/);
    });

    it('command contains two SEND actions separated by ";"', async () => {
        const result = await sdk.batch()
            .send({ tick: 'T', amount: '1', destination: ADDR })
            .send({ tick: 'T', amount: '2', destination: ADDR })
            .build();
        // The actionString encodes the semicolon-joined SEND strings
        const parts = result.actionString.split('|');
        // The command field is everything after "BATCH|<version>|"
        const command = parts.slice(2).join('|');
        const subActions = command.split(';');
        expect(subActions).to.have.length(2);
        expect(subActions[0]).to.match(/^SEND\|/);
        expect(subActions[1]).to.match(/^SEND\|/);
    });

    it('build() returns a result with action === "BATCH"', async () => {
        const result = await sdk.batch()
            .mint({ tick: 'T', amount: '1', destination: ADDR })
            .build();
        expect(result.action).to.equal('BATCH');
    });

    // Chaining

    it('all chain methods return the builder instance', () => {
        const builder = sdk.batch();
        const returned = builder
            .send({ tick: 'T', amount: '1', destination: ADDR })
            .mint({ tick: 'T', amount: '1', destination: ADDR })
            .destroy({ tick: 'T', amount: '1' });
        expect(returned).to.equal(builder);
    });

    it('.length tracks queued action count', () => {
        const builder = sdk.batch();
        expect(builder.length).to.equal(0);
        builder.send({ tick: 'T', amount: '1', destination: ADDR });
        expect(builder.length).to.equal(1);
        builder.send({ tick: 'T', amount: '2', destination: ADDR });
        expect(builder.length).to.equal(2);
    });

    it('.reset() clears the queue and returns the builder', () => {
        const builder = sdk.batch()
            .send({ tick: 'T', amount: '1', destination: ADDR })
            .send({ tick: 'T', amount: '2', destination: ADDR });
        expect(builder.length).to.equal(2);
        const returned = builder.reset();
        expect(returned).to.equal(builder);
        expect(builder.length).to.equal(0);
    });

    it('after reset, .length is 0', () => {
        const builder = sdk.batch()
            .send({ tick: 'T', amount: '1', destination: ADDR });
        builder.reset();
        expect(builder.length).to.equal(0);
    });

    // Validation

    it('empty batch .build() throws SDKValidationError with code BATCH_EMPTY', async () => {
        try {
            await sdk.batch().build();
            expect.fail('Expected SDKValidationError to be thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(SDKValidationError);
            expect(err.code).to.equal('BATCH_EMPTY');
        }
    });

    it('batch with nested BATCH throws SDKValidationError with code BATCH_CONSTRAINT', async () => {
        try {
            await sdk.batch().add('BATCH', { command: 'SEND|0|T|1|' + ADDR }).build();
            expect.fail('Expected SDKValidationError to be thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(SDKValidationError);
            expect(err.code).to.equal('BATCH_CONSTRAINT');
        }
    });

    it('batch with FILE succeeds (FILE-in-BATCH is supported)', async () => {
        // FILE in BATCH is supported as of the gated-content publishing
        // flow: BATCH(FILE, MESSAGE-to-self) atomically publishes a
        // gated FILE alongside its key-handoff MESSAGE.
        const result = await sdk.batch()
            .add('FILE', { name: 'f', type: 1, title: 't' })
            .build();
        expect(result.action).to.equal('BATCH');
        expect(result.actionString).to.match(/^BATCH\|/);
    });

    it('batch with 2 MINT of the SAME tick throws SDKValidationError with code BATCH_CONSTRAINT', async () => {
        try {
            await sdk.batch()
                .mint({ tick: 'T', amount: '1', destination: ADDR })
                .mint({ tick: 'T', amount: '2', destination: ADDR })
                .build();
            expect.fail('Expected SDKValidationError to be thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(SDKValidationError);
            expect(err.code).to.equal('BATCH_CONSTRAINT');
            expect(err.message).to.include('per distinct TICK');
            expect(err.details).to.include({ count: 2, limit: 1 });
        }
    });

    it('batch with MINTs of 2 DISTINCT ticks builds (the cap is per token)', async () => {
        const result = await sdk.batch()
            .mint({ tick: 'T', amount: '1', destination: ADDR })
            .mint({ tick: 'T2', amount: '2', destination: ADDR })
            .mint({ tick: 'T3', amount: '3', destination: ADDR })
            .build();
        expect(result.action).to.equal('BATCH');
        expect(result.actionString.split('|').slice(2).join('|').split(';')).to.have.length(3);
    });

    it('batch mixing a caret MINT tick with a named one throws, and says how to fix it', async () => {
        // `T` and `^614` can name ONE token, and only an indexer can tell; the
        // builder refuses rather than compose two bites at one scarce token.
        try {
            await sdk.batch()
                .mint({ tick: '^614', amount: '1', destination: ADDR })
                .mint({ tick: 'T', amount: '2', destination: ADDR })
                .build();
            expect.fail('Expected SDKValidationError to be thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(SDKValidationError);
            expect(err.code).to.equal('BATCH_CONSTRAINT');
            expect(err.message).to.include('caret alias');
            expect(err.message).to.include('Spell every MINT TICK by name');
            expect(err.details.ticks).to.deep.equal(['^614', 'T']);
        }
    });

    it('builds MINTs of two DIFFERENT caret ids: two ids are two tokens', async () => {
        // Caret ticks are a legal way to name an existing token, and two
        // different ids can never be one token, so there is nothing here the
        // SDK would need an indexer to resolve.
        const result = await sdk.batch()
            .mint({ tick: '^614', amount: '1', destination: ADDR })
            .mint({ tick: '^615', amount: '2', destination: ADDR })
            .build();
        expect(result.actionString.split('|').slice(2).join('|').split(';')).to.have.length(2);
    });

    it('builds MINTs of 2 distinct ticks even when tickResolver compacts both to ^<id>', async () => {
        // Compaction is ON by default, so a reachable explorer turns two names
        // into two carets. The BATCH the builder emits is re-validated as a wire
        // string on the way out; two DIFFERENT ids are two different tokens, and
        // refusing them would be a false refusal of a batch the chain accepts.
        const compacting = new XChainSDK({ network: 'bitcoin-regtest' });
        compacting.tickResolver.resolve = async (v) => ({ T: '^614', T2: '^615' }[v] || v);
        const result = await compacting.batch()
            .mint({ tick: 'T', amount: '1', destination: ADDR })
            .mint({ tick: 'T2', amount: '2', destination: ADDR })
            .build();
        const subActions = result.actionString.split('|').slice(2).join('|').split(';');
        expect(subActions).to.have.length(2);
        expect(subActions[0]).to.include('^614');
        expect(subActions[1]).to.include('^615');
    });

    it('batch with ONE DEPLOY builds: DEPLOY is capped at 1, never banned', async () => {
        const result = await sdk.batch()
            .deploy({ code_encoding: CONTRACT_B64, gas_limit: '100000' })
            .send({ tick: 'T', amount: '1', destination: ADDR })
            .build();
        expect(result.action).to.equal('BATCH');
        const subActions = result.actionString.split('|').slice(2).join('|').split(';');
        expect(subActions).to.have.length(2);
        expect(subActions[0]).to.match(/^DEPLOY\|/);
    });

    it('batch with 2 DEPLOY throws: each DEPLOY runs a constructor in the VM', async () => {
        try {
            await sdk.batch()
                .deploy({ code_encoding: CONTRACT_B64, gas_limit: '100000' })
                .deploy({ code_encoding: CONTRACT_B64, gas_limit: '100000' })
                .build();
            expect.fail('Expected SDKValidationError to be thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(SDKValidationError);
            expect(err.code).to.equal('BATCH_CONSTRAINT');
            expect(err.message).to.include('at most 1 DEPLOY');
            expect(err.details).to.include({ count: 2, limit: 1 });
        }
    });

    it('batch with 2 ISSUE throws SDKValidationError with code BATCH_CONSTRAINT', async () => {
        try {
            await sdk.batch()
                .issue({ tick: 'T', description: 'first' })
                .issue({ tick: 'T2', description: 'second' })
                .build();
            expect.fail('Expected SDKValidationError to be thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(SDKValidationError);
            expect(err.code).to.equal('BATCH_CONSTRAINT');
        }
    });

    it('batch with 1 parent ISSUE + many child ISSUEs builds (dotted TICKs are exempt)', async () => {
        const builder = sdk.batch().issue({ tick: 'JDOG', description: 'parent' });
        for (let i = 1; i <= 50; i++) builder.issue({ tick: 'JDOG.' + i, description: 'child ' + i });
        const result = await builder.build();
        expect(result.action).to.equal('BATCH');
        const command = result.actionString.split('|').slice(2).join('|');
        expect(command.split(';')).to.have.length(51);
    });

    it('batch with 2 caret-TICK ISSUEs throws: a caret is never a child', async () => {
        try {
            await sdk.batch()
                .issue({ tick: '^12.5', description: 'a' })
                .issue({ tick: '^13.6', description: 'b' })
                .build();
            expect.fail('Expected SDKValidationError to be thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(SDKValidationError);
            expect(err.code).to.equal('BATCH_CONSTRAINT');
            expect(err.message).to.include('top-level ISSUE');
        }
    });

    it('batch of 251 commands throws BATCH_CONSTRAINT, and reports the cap not the ISSUE limit', async () => {
        const builder = sdk.batch();
        for (let i = 0; i < 251; i++) builder.issue({ tick: 'JDOG.' + i, description: 'c' });
        try {
            await builder.build();
            expect.fail('Expected SDKValidationError to be thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(SDKValidationError);
            expect(err.code).to.equal('BATCH_CONSTRAINT');
            expect(err.message).to.include('at most 250 commands');
            expect(err.details).to.include({ count: 251, limit: 250 });
        }
    });

    it('batch of exactly 250 child ISSUEs builds', async () => {
        const builder = sdk.batch();
        for (let i = 0; i < 250; i++) builder.issue({ tick: 'JDOG.' + i, description: 'c' });
        const result = await builder.build();
        expect(result.actionString.split('|').slice(2).join('|').split(';')).to.have.length(250);
    });

    // Sub-action validation

    it('batch with invalid sub-action params (SEND missing tick) throws SDKValidationError', async () => {
        try {
            await sdk.batch()
                .send({ amount: '1', destination: ADDR }) // missing tick
                .build();
            expect.fail('Expected SDKValidationError to be thrown');
        } catch (err) {
            expect(err).to.be.instanceOf(SDKValidationError);
        }
    });

    it('batch with 1 MINT + 1 SEND succeeds', async () => {
        const result = await sdk.batch()
            .mint({ tick: 'T', amount: '1', destination: ADDR })
            .send({ tick: 'T', amount: '1', destination: ADDR })
            .build();
        expect(result.action).to.equal('BATCH');
        expect(result.actionString).to.be.a('string').and.to.have.length.above(0);
    });

    // Builder independence

    it('two BatchBuilders from same SDK do not interfere with each other', async () => {
        const builderA = sdk.batch().send({ tick: 'A', amount: '1', destination: ADDR });
        const builderB = sdk.batch().send({ tick: 'B', amount: '2', destination: ADDR });

        expect(builderA.length).to.equal(1);
        expect(builderB.length).to.equal(1);

        const resultA = await builderA.build();
        const resultB = await builderB.build();

        expect(resultA.actionString).to.not.equal(resultB.actionString);
        expect(resultA.actionString).to.include('A');
        expect(resultB.actionString).to.include('B');
    });

});
