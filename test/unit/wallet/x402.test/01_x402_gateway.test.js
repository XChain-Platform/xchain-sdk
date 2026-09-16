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

const { X402Gateway } = require('../../../../src/utils/x402.js');
const { waitFor } = require('../../../helpers/wait.js');

const NONCE = 'a'.repeat(32);

let tmpDir, explorer;

// These tests exercise the scheme LOGIC with the payer-signature binding
// explicitly disabled (requireSignature:false). The binding itself is
// covered in its own describe block below, with real keys + a network.
const mkGateway = (over) => new X402Gateway(Object.assign({
    coin: 'TDOGE', explorer, requireSignature: false,
    send: { tick: 'TOK', amount: '5', payTo: 'gateAddr', minConfirmations: 1 },
    stateDir: tmpDir,
}, over));

const sendRow = (over) => Object.assign({
    source: 'payerAddr', destination: 'gateAddr', tick: 'TOK',
    amount: '5', memo: NONCE, status: 'valid', tx_hash: 'txCC', block_index: 77,
}, over);

const proof = (over) => Object.assign({
    x402Version: 1, scheme: 'xchain-send', coin: 'TDOGE',
    txid: 'txCC', invoice: NONCE, payer: 'payerAddr',
}, over);

// Issue a challenge whose nonce we control by stubbing randomBytes.
async function issueInvoice(gw) {
    const rb = sinon.stub(require('crypto'), 'randomBytes').returns(Buffer.from('aa'.repeat(16), 'hex'));
    try { return await gw.challengeBody('/r'); } finally { rb.restore(); }
}

function setupGateway() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-'));
    explorer = {
        getSends:    sinon.stub().resolves({ data: [] }),
        getMempool:  sinon.stub().resolves({ data: [] }),
        getBalances: sinon.stub().resolves({ data: [] }),
        // Index-id resolution for the 0-conf compaction matcher: payTo 'gateAddr' -> id 3,
        // tick 'TOK' -> id 7. Present so resolveWireIds can accept `^<id>` wire forms.
        getAddress:  sinon.stub().resolves({ info: { address_id: 3 } }),
        getToken:    sinon.stub().resolves({ info: { tick_id: 7 } }),
    };
}

describe('x402', () => {
    /* ── gateway ───────────────────────────────────────────────────── */

    describe('X402Gateway', () => {
        beforeEach(setupGateway);
        afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

        it('challenge issues a pending invoice and an accepts entry', async () => {
            const gw = mkGateway();
            const body = await issueInvoice(gw);
            expect(body.x402Version).to.equal(1);
            expect(body.accepts[0]).to.include({ scheme: 'xchain-send', tick: 'TOK', amount: '5', payTo: 'gateAddr', invoice: NONCE });
            const inv = await gw.store.get(NONCE);
            expect(inv.status).to.equal('pending');
        });

        it('verifies a confirmed SEND and claims the invoice exactly once', async () => {
            const gw = mkGateway();
            await issueInvoice(gw);
            explorer.getSends.resolves({ data: [sendRow()] });
            const r1 = await gw.verify(proof());
            expect(r1).to.include({ ok: true, status: 'confirmed', txid: 'txCC' });
            const r2 = await gw.verify(proof());
            expect(r2).to.include({ ok: false, code: 'X402_INVOICE_ALREADY_USED' });
        });

        it('rejects wrong payer, short amount, wrong memo, invalid status', async () => {
            const gw = mkGateway();
            await issueInvoice(gw);
            for (const bad of [
                sendRow({ source: 'frontrunner' }),
                sendRow({ amount: '4.999999' }),
                sendRow({ memo: NONCE.replace('a', 'b') }),
                sendRow({ status: 'invalid: insufficient balance' }),
            ]) {
                explorer.getSends.resolves({ data: [bad] });
                const r = await gw.verify(proof());
                expect(r.ok, JSON.stringify(bad)).to.equal(false);
            }
        });

        it('rejects expired invoices (with grace) and unknown nonces', async () => {
            const gw = mkGateway({ send: { tick: 'TOK', amount: '5', payTo: 'gateAddr', ttlMs: 1000 } });
            await issueInvoice(gw);
            const clock = sinon.useFakeTimers({ now: Date.now() + 12000, toFake: ['Date'] });
            try {
                explorer.getSends.resolves({ data: [sendRow()] });
                const r = await gw.verify(proof());
                expect(r).to.include({ ok: false, code: 'X402_INVOICE_EXPIRED' });
            } finally { clock.restore(); }
            expect((await gw.verify(proof({ invoice: 'f'.repeat(32) }))).code).to.equal('X402_UNKNOWN_INVOICE');
        });
    });
});

describe('x402', () => {
    describe('X402Gateway', () => {
        beforeEach(setupGateway);
        afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

        it('0-conf: grants provisionally from a parsed mempool SEND (multi-output pairing enforced)', async () => {
            const gw = mkGateway({ send: { tick: 'TOK', amount: '5', payTo: 'gateAddr', minConfirmations: 0 } });
            await issueInvoice(gw);
            // v1 multi-output: the BIG amount goes elsewhere; gateAddr's output is only 2, must NOT pass
            explorer.getMempool.resolves({ data: [{ tx_hash: 'txDD', source: 'payerAddr', action: 'SEND', data: `SEND|1|TOK|100|other|2|gateAddr|${NONCE}` }] });
            expect((await gw.verify(proof({ txid: 'txDD' }))).ok).to.equal(false);
            // correct amount on the gateAddr output passes provisionally
            explorer.getMempool.resolves({ data: [{ tx_hash: 'txDD', source: 'payerAddr', action: 'SEND', data: `SEND|1|TOK|1|other|5|gateAddr|${NONCE}` }] });
            const r = await gw.verify(proof({ txid: 'txDD' }));
            expect(r).to.include({ ok: true, status: 'provisional_0conf', provisional: true });
        });

        it('0-conf: matches a mempool SEND whose destination+tick are SDK-compacted to ^<id> (default client)', async () => {
            // The reference X402Client pays via session.send(), which by default compacts payTo and
            // tick to their `^<id>` wire form. The decoder records that raw compacted string in the
            // mempool `data` column (only the indexer expands ids). Query is keyed on the payer (the
            // on-chain source), and resolveWireIds maps gateAddr->^3, TOK->^7 so the output matches.
            const gw = mkGateway({ send: { tick: 'TOK', amount: '5', payTo: 'gateAddr', minConfirmations: 0 } });
            await issueInvoice(gw);
            explorer.getMempool.resolves({ data: [{ tx_hash: 'txZZ', source: 'payerAddr', action: 'SEND', data: `SEND|0|^7|5|^3|${NONCE}` }] });
            const r = await gw.verify(proof({ txid: 'txZZ' }));
            expect(r).to.include({ ok: true, status: 'provisional_0conf', provisional: true });
            // The mempool query must be keyed on the payer, not payTo (a payTo query misses a
            // compacted-destination row because payTo is not a segment of the raw action string).
            expect(explorer.getMempool.calledWith('payerAddr', 'address', sinon.match.any)).to.equal(true);
        });

        it('0-conf: a compacted ^<id> destination for the WRONG address does not match', async () => {
            const gw = mkGateway({ send: { tick: 'TOK', amount: '5', payTo: 'gateAddr', minConfirmations: 0 } });
            await issueInvoice(gw);
            // ^9 is some other address id (not gateAddr's ^3); tick ^7 is correct. Must NOT match.
            explorer.getMempool.resolves({ data: [{ tx_hash: 'txYY', source: 'payerAddr', action: 'SEND', data: `SEND|0|^7|5|^9|${NONCE}` }] });
            expect((await gw.verify(proof({ txid: 'txYY' }))).ok).to.equal(false);
        });

        it('0-conf mempool match requires the payer to be the on-chain source', async () => {
            const gw = mkGateway({ send: { tick: 'TOK', amount: '5', payTo: 'gateAddr', minConfirmations: 0 } });
            await issueInvoice(gw);
            explorer.getMempool.resolves({ data: [{ tx_hash: 'txDD', source: 'realPayer', action: 'SEND', data: `SEND|0|TOK|5|gateAddr|${NONCE}` }] });
            const r = await gw.verify(proof({ payer: 'frontrunner' }));
            expect(r).to.include({ ok: false, code: 'X402_PAYMENT_NOT_FOUND' });
        });
    });
});

describe('x402', () => {
    describe('X402Gateway', () => {
        beforeEach(setupGateway);
        afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

        it('sweeper promotes provisional grants on confirmation and fails them after the window', async () => {
            const failed = [];
            const gw = mkGateway({
                send: { tick: 'TOK', amount: '5', payTo: 'gateAddr', minConfirmations: 0 },
                confirmWindowMs: 1000,
                onProvisionalFailed: (inv) => failed.push(inv.nonce),
            });
            await issueInvoice(gw);
            explorer.getMempool.resolves({ data: [{ tx_hash: 'txDD', source: 'payerAddr', action: 'SEND', data: `SEND|0|TOK|5|gateAddr|${NONCE}` }] });
            await gw.verify(proof({ txid: 'txDD' }));

            // confirmation arrives → promote
            explorer.getSends.resolves({ data: [sendRow({ tx_hash: 'txDD' })] });
            await gw.sweep();
            expect((await gw.store.get(NONCE)).status).to.equal('confirmed');

            // a second provisional that never confirms → failed + operator hook
            const gw2 = mkGateway({
                send: { tick: 'TOK', amount: '5', payTo: 'gateAddr', minConfirmations: 0 },
                confirmWindowMs: 1, stateDir: tmpDir + '2',
                onProvisionalFailed: (inv) => failed.push(inv.nonce),
            });
            await issueInvoice(gw2);
            explorer.getMempool.resolves({ data: [{ tx_hash: 'txEE', source: 'payerAddr', action: 'SEND', data: `SEND|0|TOK|5|gateAddr|${NONCE}` }] });
            explorer.getSends.resolves({ data: [] });
            await gw2.verify(proof({ txid: 'txEE' }));
            // Poll the real state transition instead of sleeping past the 1ms window:
            // sweep repeatedly until the unconfirmed grant is marked failed. Once the
            // window lapses a single sweep flips it (and fires the hook exactly once,
            // since it is then no longer provisional).
            await waitFor(async () => {
                await gw2.sweep();
                return (await gw2.store.get(NONCE)).status === 'failed_0conf';
            }, { message: 'provisional grant should fail once the confirm window elapses' });
            expect((await gw2.store.get(NONCE)).status).to.equal('failed_0conf');
            expect(failed).to.deep.equal([NONCE]);
            fs.rmSync(tmpDir + '2', { recursive: true, force: true });
        });
    });
});

describe('x402', () => {
    describe('X402Gateway', () => {
        beforeEach(setupGateway);
        afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

        it('dispenser scheme: hold-to-access via balances', async () => {
            const gw = mkGateway({ send: null, dispenser: { holdTick: 'ACCESS', minBalance: '1', dispenserIndex: 42 } });
            explorer.getBalances.resolves({ data: [{ tick: 'ACCESS', amount: '1' }] });
            expect((await gw.verify({ x402Version: 1, scheme: 'xchain-dispenser', coin: 'TDOGE', payer: 'p1' })).ok).to.equal(true);
            explorer.getBalances.resolves({ data: [{ tick: 'ACCESS', amount: '0.5' }] });
            expect((await gw.verify({ x402Version: 1, scheme: 'xchain-dispenser', coin: 'TDOGE', payer: 'p1' })).code).to.equal('X402_INSUFFICIENT_HOLDING');
        });

        it('deposit scheme: debits per call, exhausts, and serializes concurrent debits', async () => {
            const gw = mkGateway({ send: null, deposit: { tick: 'TOK', depositAddress: 'depAddr', pricePerCall: '4' } });
            explorer.getSends.resolves({ data: [sendRow({ destination: 'depAddr', amount: '10', memo: '' })] });
            const dp = { x402Version: 1, scheme: 'xchain-deposit', coin: 'TDOGE', payer: 'payerAddr' };
            const [r1, r2, r3] = await Promise.all([gw.verify(dp, '/a'), gw.verify(dp, '/b'), gw.verify(dp, '/c')]);
            const oks = [r1, r2, r3].filter((r) => r.ok);
            expect(oks).to.have.lengthOf(2);                          // 10 funds exactly two 4-priced calls
            expect([r1, r2, r3].find((r) => !r.ok).code).to.equal('X402_DEPOSIT_EXHAUSTED');
        });

        it('guard(): 402 challenge without proof; 200 path sets X-Payment-Response', async () => {
            const gw = mkGateway();
            const mkRes = () => {
                const res = { headers: {}, statusCode: 200, body: null };
                res.setHeader = (k, v) => { res.headers[k] = v; };
                res.end = (b) => { res.body = b; };
                return res;
            };
            let res = mkRes();
            expect(await gw.guard({ headers: {}, url: '/r' }, res)).to.equal(false);
            expect(res.statusCode).to.equal(402);
            expect(JSON.parse(res.body).accepts[0].scheme).to.equal('xchain-send');

            const inv = JSON.parse(res.body).accepts[0].invoice;
            explorer.getSends.resolves({ data: [sendRow({ memo: inv })] });
            const header = Buffer.from(JSON.stringify({ x402Version: 1, scheme: 'xchain-send', coin: 'TDOGE', txid: 'txCC', invoice: inv, payer: 'payerAddr' })).toString('base64url');
            res = mkRes();
            const req = { headers: { 'x-payment': header }, url: '/r' };
            expect(await gw.guard(req, res)).to.equal(true);
            expect(req.x402.status).to.equal('confirmed');
            const decoded = JSON.parse(Buffer.from(res.headers['X-Payment-Response'], 'base64url').toString('utf8'));
            expect(decoded.status).to.equal('confirmed');
        });
    });
});
