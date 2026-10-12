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
 * Unit tests for the X402Client spend ceiling: the remote server names
 * the tick, amount and payee, so the client caps each tick separately,
 * refuses a tick it has no ceiling for, and refuses a malformed offer
 * before session.send is ever called.
 *
 ********************************************************************/

'use strict';

const sinon  = require('sinon');
const { expect } = require('chai');

const { X402Client } = require('../../../../src/utils/x402.js');

const NONCE = 'b'.repeat(32);

// Build a challenge carrying one xchain-send offer with the given fields
function challengeWith(fields) {
    return {
        x402Version: 1, error: 'Payment Required', resource: '/r',
        accepts: [Object.assign({ scheme: 'xchain-send', coin: 'TDOGE', tick: 'TOK', amount: '5', payTo: 'gateAddr',
            invoice: NONCE, expiresAt: Date.now() + 60000, minConfirmations: 0 }, fields)],
    };
}

// Answer 402 with `body` first, then 200 for the proof-bearing retry
function fetchFor(body) {
    let i = 0;
    return sinon.stub().callsFake(async () => ({ status: i++ === 0 ? 402 : 200, json: async () => body, headers: {} }));
}

function paidSession() {
    return { address: 'p', send: sinon.stub().resolves({ txid: 't' }) };
}

async function refusal(p) {
    try { await p; } catch (e) { return e; }
    return null;
}

describe('x402', () => {
    describe('X402Client per-tick ceiling', () => {
        it('pays an offer within the ceiling set for its tick', async () => {
            const session = paidSession();
            const client = new X402Client({ session, fetch: fetchFor(challengeWith({})), maxAmount: { TOK: '10' }, retryDelayMs: 1, maxRetries: 3 });
            const res = await client.fetchUrl('http://x/r');
            expect(res.status).to.equal(200);
            expect(session.send.firstCall.args[0]).to.include({ tick: 'TOK', amount: '5' });
        });

        it('refuses a server-named tick that has no ceiling, without paying', async () => {
            const session = paidSession();
            const client = new X402Client({ session, fetch: fetchFor(challengeWith({ tick: 'GOLD', amount: '1' })), maxAmount: { TOK: '10' }, retryDelayMs: 1 });
            const err = await refusal(client.fetchUrl('http://x/r'));
            expect(err && err.code).to.equal('X402_TICK_NOT_ALLOWED');
            expect(session.send.called).to.equal(false);
        });

        it('refuses every offer when no maxAmount is given, without paying', async () => {
            const session = paidSession();
            const client = new X402Client({ session, fetch: fetchFor(challengeWith({ amount: '1' })), retryDelayMs: 1 });
            const err = await refusal(client.fetchUrl('http://x/r'));
            expect(err && err.code).to.equal('X402_TICK_NOT_ALLOWED');
            expect(session.send.called).to.equal(false);
        });

        it('matches a ceiling key to the offer tick regardless of case', async () => {
            const session = paidSession();
            const client = new X402Client({ session, fetch: fetchFor(challengeWith({})), maxAmount: { tok: '10' }, retryDelayMs: 1, maxRetries: 3 });
            const res = await client.fetchUrl('http://x/r');
            expect(res.status).to.equal(200);
        });

    });
});

describe('x402', () => {
    describe('X402Client per-tick ceiling', () => {
        it('refuses an offer above its tick ceiling, without paying', async () => {
            const session = paidSession();
            const client = new X402Client({ session, fetch: fetchFor(challengeWith({ amount: '11' })), maxAmount: { TOK: '10' }, retryDelayMs: 1 });
            const err = await refusal(client.fetchUrl('http://x/r'));
            expect(err && err.code).to.equal('X402_PRICE_TOO_HIGH');
            expect(session.send.called).to.equal(false);
        });

        it('refuses a malformed offer amount, tick or payee, without paying', async () => {
            const bad = [{ amount: '1e3' }, { amount: '-5' }, { amount: '0' }, { amount: 'abc' }, { amount: undefined },
                { tick: '' }, { tick: undefined }, { payTo: '' }, { payTo: undefined }];
            for (const fields of bad) {
                const session = paidSession();
                const client = new X402Client({ session, fetch: fetchFor(challengeWith(fields)), allowUnbounded: true, retryDelayMs: 1 });
                const err = await refusal(client.fetchUrl('http://x/r'));
                expect(err && err.code, JSON.stringify(fields)).to.equal('X402_BAD_OFFER');
                expect(session.send.called, JSON.stringify(fields)).to.equal(false);
            }
        });

        it('rejects a malformed ceiling at construction', () => {
            for (const maxAmount of [{ TOK: '-1' }, { TOK: 'abc' }, '0', '1e3', 'abc', -1]) {
                let err = null;
                try { new X402Client({ session: paidSession(), fetch: sinon.stub(), maxAmount }); } catch (e) { err = e; }
                expect(err && err.code, JSON.stringify(maxAmount)).to.equal('X402_CONFIG');
            }
        });
    });
});
