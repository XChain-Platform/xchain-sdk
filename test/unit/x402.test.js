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
 * Unit tests for src/x402.js — action-string parsing (incl. spoof
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

const { X402Gateway, X402Client, parseActionString } = require('../../src/x402.js');
const { SDKX402Error, SDKPolicyError } = require('../../src/errors.js');

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

    /* ── gateway ───────────────────────────────────────────────────── */

    describe('X402Gateway', () => {
        let tmpDir, explorer;

        const mkGateway = (over) => new X402Gateway(Object.assign({
            coin: 'TDOGE', explorer,
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

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-'));
            explorer = {
                getSends:    sinon.stub().resolves({ data: [] }),
                getMempool:  sinon.stub().resolves({ data: [] }),
                getBalances: sinon.stub().resolves({ data: [] }),
            };
        });
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

        it('0-conf: grants provisionally from a parsed mempool SEND (multi-output pairing enforced)', async () => {
            const gw = mkGateway({ send: { tick: 'TOK', amount: '5', payTo: 'gateAddr', minConfirmations: 0 } });
            await issueInvoice(gw);
            // v1 multi-output: the BIG amount goes elsewhere; gateAddr's output is only 2 — must NOT pass
            explorer.getMempool.resolves({ data: [{ tx_hash: 'txDD', source: 'payerAddr', action: 'SEND', data: `SEND|1|TOK|100|other|2|gateAddr|${NONCE}` }] });
            expect((await gw.verify(proof({ txid: 'txDD' }))).ok).to.equal(false);
            // correct amount on the gateAddr output passes provisionally
            explorer.getMempool.resolves({ data: [{ tx_hash: 'txDD', source: 'payerAddr', action: 'SEND', data: `SEND|1|TOK|1|other|5|gateAddr|${NONCE}` }] });
            const r = await gw.verify(proof({ txid: 'txDD' }));
            expect(r).to.include({ ok: true, status: 'provisional_0conf', provisional: true });
        });

        it('0-conf mempool match requires the payer to be the on-chain source', async () => {
            const gw = mkGateway({ send: { tick: 'TOK', amount: '5', payTo: 'gateAddr', minConfirmations: 0 } });
            await issueInvoice(gw);
            explorer.getMempool.resolves({ data: [{ tx_hash: 'txDD', source: 'realPayer', action: 'SEND', data: `SEND|0|TOK|5|gateAddr|${NONCE}` }] });
            const r = await gw.verify(proof({ payer: 'frontrunner' }));
            expect(r).to.include({ ok: false, code: 'X402_PAYMENT_NOT_FOUND' });
        });

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
            await new Promise((r) => setTimeout(r, 5));
            await gw2.sweep();
            expect((await gw2.store.get(NONCE)).status).to.equal('failed_0conf');
            expect(failed).to.deep.equal([NONCE]);
            fs.rmSync(tmpDir + '2', { recursive: true, force: true });
        });

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

    /* ── client ────────────────────────────────────────────────────── */

    describe('X402Client', () => {
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

        it('gives up with X402_PAYMENT_NOT_ACCEPTED after maxRetries', async () => {
            const session = { address: 'p', send: sinon.stub().resolves({ txid: 't' }) };
            const client = new X402Client({ session, fetch: mkFetch([402, 402, 402, 402]), retryDelayMs: 1, maxRetries: 2 });
            try { await client.fetchUrl('http://x/r'); throw new Error('nope'); }
            catch (e) { expect(e.code).to.equal('X402_PAYMENT_NOT_ACCEPTED'); }
        });
    });

    it('exports are wired into the SDK entry point', () => {
        const sdkIndex = require('../../index.js');
        expect(sdkIndex.X402Gateway).to.be.a('function');
        expect(sdkIndex.X402Client).to.be.a('function');
        expect(sdkIndex.SDKX402Error).to.equal(SDKX402Error);
    });
});
