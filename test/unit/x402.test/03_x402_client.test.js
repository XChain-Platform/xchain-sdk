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

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const sinon  = require('sinon');
const { expect } = require('chai');

const { X402Gateway, X402Client } = require('../../../src/utils/x402.js');
const { SDKPolicyError, SDKActionError } = require('../../../src/utils/errors.js');

const NONCE = 'a'.repeat(32);

const challenge = {
    x402Version: 1, error: 'Payment Required', resource: '/r',
    accepts: [{ scheme: 'xchain-send', coin: 'TDOGE', tick: 'TOK', amount: '5', payTo: 'gateAddr', invoice: NONCE, expiresAt: Date.now() + 60000, minConfirmations: 0 }],
};

function mkFetch(sequence) {
    let i = 0;
    return sinon.stub().callsFake(async () => {
        const status = sequence[Math.min(i++, sequence.length - 1)];
        return { status, json: async () => challenge, headers: {} };
    });
}

describe('x402', () => {
    /* ── client ────────────────────────────────────────────────────── */

    describe('X402Client', () => {
        it('pays via the session and retries with the proof header until 200', async () => {
            const session = { address: 'payerAddr', send: sinon.stub().resolves({ txid: 'txZZ' }) };
            const f = mkFetch([402, 402, 200]);
            const client = new X402Client({ session, fetch: f, retryDelayMs: 1, maxRetries: 5 });
            const res = await client.fetchUrl('http://x/r');
            expect(res.status).to.equal(200);
            expect(session.send.firstCall.args[0]).to.deep.equal({ tick: 'TOK', amount: '5', destination: 'gateAddr', memo: NONCE });
            expect(session.send.firstCall.args[2]).to.deep.equal({ waitForIndexer: false });   // 0-conf offer
            const hdrs = f.thirdCall.args[1].headers;
            const proof = JSON.parse(Buffer.from(hdrs['X-Payment'], 'base64url').toString('utf8'));
            expect(proof).to.include({ scheme: 'xchain-send', invoice: NONCE, payer: 'payerAddr', txid: 'txZZ' });
        });

        it('enforces maxAmount before paying and propagates AgentSession policy refusals', async () => {
            const session = { address: 'p', send: sinon.stub().rejects(new SDKPolicyError('POLICY_AMOUNT_EXCEEDED', 'cap')) };
            const cheap = new X402Client({ session, fetch: mkFetch([402]), maxAmount: '4', retryDelayMs: 1 });
            try { await cheap.fetchUrl('http://x/r'); throw new Error('nope'); }
            catch (e) { expect(e.code).to.equal('X402_PRICE_TOO_HIGH'); }
            expect(session.send.called).to.equal(false);

            const willing = new X402Client({ session, fetch: mkFetch([402]), retryDelayMs: 1 });
            try { await willing.fetchUrl('http://x/r'); throw new Error('nope'); }
            catch (e) { expect(e).to.be.instanceOf(SDKPolicyError); }
        });

        it('surfaces X402_PAYMENT_AMBIGUOUS carrying the txid after maxRetries (no silent re-pay)', async () => {
            const session = { address: 'p', send: sinon.stub().resolves({ txid: 't' }) };
            const client = new X402Client({ session, fetch: mkFetch([402, 402, 402, 402]), retryDelayMs: 1, maxRetries: 2 });
            try { await client.fetchUrl('http://x/r'); throw new Error('nope'); }
            catch (e) {
                expect(e.code).to.equal('X402_PAYMENT_AMBIGUOUS');
                expect(e.details.txid).to.equal('t');
                expect(e.details.paid).to.equal(true);
                expect(e.details.resume).to.include({ txid: 't', invoice: NONCE });
            }
        });

        it('a post-broadcast send throw (CONFIRMATION_TIMEOUT) becomes X402_PAYMENT_AMBIGUOUS with the txid', async () => {
            const timeout = new SDKActionError('CONFIRMATION_TIMEOUT', 'timed out', { txid: 'txLIMBO' });
            const session = { address: 'p', send: sinon.stub().rejects(timeout) };
            const client = new X402Client({ session, fetch: mkFetch([402]), retryDelayMs: 1 });
            try { await client.fetchUrl('http://x/r'); throw new Error('nope'); }
            catch (e) {
                expect(e.code).to.equal('X402_PAYMENT_AMBIGUOUS');
                expect(e.details.txid).to.equal('txLIMBO');
                expect(e.details.resume.txid).to.equal('txLIMBO');
            }
        });
    });
});

describe('x402', () => {
    describe('X402Client', () => {
        it('a pre-broadcast policy refusal (no txid) propagates unchanged', async () => {
            const session = { address: 'p', send: sinon.stub().rejects(new SDKPolicyError('POLICY_AMOUNT_EXCEEDED', 'cap')) };
            const client = new X402Client({ session, fetch: mkFetch([402]), maxAmount: '10', retryDelayMs: 1 });
            try { await client.fetchUrl('http://x/r'); throw new Error('nope'); }
            catch (e) { expect(e).to.be.instanceOf(SDKPolicyError); }
        });

        it('resume re-presents the existing payment without calling session.send again (no double-pay)', async () => {
            const session = { address: 'payerAddr', send: sinon.stub().resolves({ txid: 'txNEW' }) };
            // Gateway accepts on the first proof-bearing request.
            const f = mkFetch([200]);
            const client = new X402Client({ session, fetch: f, retryDelayMs: 1, maxRetries: 5 });
            const res = await client.fetchUrl('http://x/r', {}, { resume: { invoice: NONCE, txid: 'txPRIOR', coin: 'TDOGE' } });
            expect(res.status).to.equal(200);
            expect(session.send.called).to.equal(false);            // never paid again
            const hdrs = f.firstCall.args[1].headers;
            const proof = JSON.parse(Buffer.from(hdrs['X-Payment'], 'base64url').toString('utf8'));
            expect(proof).to.include({ txid: 'txPRIOR', invoice: NONCE });   // adopted the prior payment
        });

        it('default ceiling blocks an over-priced offer when no maxAmount is given', async () => {
            const session = { address: 'p', send: sinon.stub().resolves({ txid: 't' }) };
            const dear = { ...challenge, accepts: [{ ...challenge.accepts[0], amount: '100000' }] };
            const f = sinon.stub().resolves({ status: 402, json: async () => dear, headers: {} });
            const client = new X402Client({ session, fetch: f, retryDelayMs: 1 });
            try { await client.fetchUrl('http://x/r'); throw new Error('nope'); }
            catch (e) { expect(e.code).to.equal('X402_PRICE_TOO_HIGH'); }
            expect(session.send.called).to.equal(false);
        });

        it('allowUnbounded opts out of the default ceiling and pays an expensive offer', async () => {
            const session = { address: 'p', send: sinon.stub().resolves({ txid: 't' }) };
            const dear = { ...challenge, accepts: [{ ...challenge.accepts[0], amount: '100000' }] };
            let i = 0;
            const f = sinon.stub().callsFake(async () => ({ status: [402, 200][Math.min(i++, 1)], json: async () => dear, headers: {} }));
            const client = new X402Client({ session, fetch: f, allowUnbounded: true, retryDelayMs: 1, maxRetries: 3 });
            const res = await client.fetchUrl('http://x/r');
            expect(res.status).to.equal(200);
            expect(session.send.calledOnce).to.equal(true);
        });
    });
});

describe('x402', () => {
    describe('X402Client', () => {
        it('signs the invoice for a requireSignature send offer and the gateway accepts it end-to-end', async () => {
            const { ECPairFactory } = require('ecpair');
            const ecc = require('@bitcoinerlab/secp256k1');
            const { getNetwork } = require('../../../src/protocol/networks.js');
            const AuthUtils = require('../../../src/utils/auth.js');
            const NET = 'dogecoin-testnet';
            const netParams = getNetwork(NET);
            const auth = new AuthUtils(NET);
            const WIF = ECPairFactory(ecc).makeRandom({ network: netParams }).toWIF();
            const PAYER = auth.signMessage('probe', WIF).address;

            const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'x402e2e-'));
            const explorer = {
                getSends:    sinon.stub().resolves({ data: [{ source: PAYER, destination: 'gateAddr', tick: 'TOK', amount: '5', memo: NONCE, status: 'valid', tx_hash: 'txZZ', block_index: 3 }] }),
                getMempool:  sinon.stub().resolves({ data: [] }),
                getBalances: sinon.stub().resolves({ data: [] }),
                getAddress:  sinon.stub().resolves({ info: { address_id: 3 } }),
                getToken:    sinon.stub().resolves({ info: { tick_id: 7 } }),
            };
            const gw = new X402Gateway({ coin: 'TDOGE', explorer, network: NET, challengeSecret: 's',
                send: { tick: 'TOK', amount: '5', payTo: 'gateAddr', minConfirmations: 1 }, stateDir: tmp });
            try {
                // Issue the invoice with a controlled nonce so the offer carries NONCE.
                const rb = sinon.stub(require('crypto'), 'randomBytes').returns(Buffer.from('aa'.repeat(16), 'hex'));
                let body; try { body = await gw.challengeBody('/r'); } finally { rb.restore(); }
                const offer = body.accepts.find((a) => a.scheme === 'xchain-send');
                expect(offer.requireSignature).to.equal(true);

                // The client fetch loop: 402 (with our offer) then delegate the retry to gw.verify.
                const session = { address: PAYER, wif: WIF, sdk: { options: { network: NET } },
                                  send: sinon.stub().resolves({ txid: 'txZZ' }) };
                let seen = 0;
                const fetch = sinon.stub().callsFake(async (url, init) => {
                    if (seen++ === 0) return { status: 402, json: async () => body, headers: {} };
                    const hdr = init.headers['X-Payment'];
                    const proof = X402Gateway.parseProofHeader(hdr);
                    const result = await gw.verify(proof, '/r');
                    return { status: result.ok ? 200 : 402, json: async () => body, headers: {} };
                });
                const client = new X402Client({ session, fetch, retryDelayMs: 1, maxRetries: 3 });
                const res = await client.fetchUrl('http://x/r');
                expect(res.status).to.equal(200);
            } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
        });
    });
});
