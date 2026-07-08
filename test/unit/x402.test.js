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
 * Unit tests for src/x402.js: action-string parsing (incl. spoof
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

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-'));
            explorer = {
                getSends:    sinon.stub().resolves({ data: [] }),
                getMempool:  sinon.stub().resolves({ data: [] }),
                getBalances: sinon.stub().resolves({ data: [] }),
                // Index-id resolution for the 0-conf compaction matcher: payTo 'gateAddr' -> id 3,
                // tick 'TOK' -> id 7. Present so _resolveWireIds can accept `^<id>` wire forms.
                getAddress:  sinon.stub().resolves({ info: { address_id: 3 } }),
                getToken:    sinon.stub().resolves({ info: { tick_id: 7 } }),
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
            // on-chain source), and _resolveWireIds maps gateAddr->^3, TOK->^7 so the output matches.
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

    /* ── payer-signature binding (default: requireSignature ON) ─────── */

    describe('X402Gateway payer-signature binding', () => {
        const { ECPairFactory } = require('ecpair');
        const ecc = require('@bitcoinerlab/secp256k1');
        const { getNetwork } = require('../../src/networks.js');
        const AuthUtils = require('../../src/auth.js');
        const ECPair = ECPairFactory(ecc);

        const NET = 'dogecoin-testnet';   // matches coin TDOGE
        const netParams = getNetwork(NET);
        const auth = new AuthUtils(NET);

        // A real payer keypair + its p2pkh address (what signMessage derives).
        const kp = ECPair.makeRandom({ network: netParams });
        const WIF = kp.toWIF();
        const PAYER = auth.signMessage('probe', WIF).address;   // p2pkh address for this key
        // An unrelated attacker key (controls its OWN address, not PAYER's).
        const attackerWif = ECPair.makeRandom({ network: netParams }).toWIF();

        let tmpDir, explorer;
        const mkGw = (over) => new X402Gateway(Object.assign({
            coin: 'TDOGE', explorer, network: NET, challengeSecret: 'unit-test-secret',
            stateDir: tmpDir,
        }, over));

        async function issueSend(gw) {
            const rb = sinon.stub(require('crypto'), 'randomBytes').returns(Buffer.from('aa'.repeat(16), 'hex'));
            try { return await gw.challengeBody('/r'); } finally { rb.restore(); }
        }

        beforeEach(() => {
            tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402sig-'));
            explorer = {
                getSends:    sinon.stub().resolves({ data: [] }),
                getMempool:  sinon.stub().resolves({ data: [] }),
                getBalances: sinon.stub().resolves({ data: [] }),
                getAddress:  sinon.stub().resolves({ info: { address_id: 3 } }),
                getToken:    sinon.stub().resolves({ info: { tick_id: 7 } }),
            };
        });
        afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

        it('requires a network when signature binding is on', () => {
            expect(() => new X402Gateway({ coin: 'TDOGE', explorer, send: { tick: 'T', amount: '1', payTo: 'g' }, stateDir: tmpDir }))
                .to.throw(/network is required/);
        });

        it('send: rejects an unsigned proof, then accepts one signed over the invoice nonce', async () => {
            const gw = mkGw({ send: { tick: 'TOK', amount: '5', payTo: 'gateAddr', minConfirmations: 1 } });
            await issueSend(gw);
            explorer.getSends.resolves({ data: [{ source: PAYER, destination: 'gateAddr', tick: 'TOK', amount: '5', memo: NONCE, status: 'valid', tx_hash: 'txCC', block_index: 9 }] });

            const unsigned = { x402Version: 1, scheme: 'xchain-send', coin: 'TDOGE', txid: 'txCC', invoice: NONCE, payer: PAYER };
            expect((await gw.verify(unsigned)).code).to.equal('X402_SIGNATURE_REQUIRED');

            const signed = Object.assign({}, unsigned, { payerSignature: auth.signMessage(NONCE, WIF).signature });
            expect((await gw.verify(signed)).ok).to.equal(true);
        });

        it('send: rejects a signature from a different key (front-run defense)', async () => {
            const gw = mkGw({ send: { tick: 'TOK', amount: '5', payTo: 'gateAddr', minConfirmations: 1 } });
            await issueSend(gw);
            explorer.getSends.resolves({ data: [{ source: PAYER, destination: 'gateAddr', tick: 'TOK', amount: '5', memo: NONCE, status: 'valid', tx_hash: 'txCC', block_index: 9 }] });
            // Attacker copies the public payer+memo but signs with their own key.
            const forged = { x402Version: 1, scheme: 'xchain-send', coin: 'TDOGE', txid: 'txCC', invoice: NONCE, payer: PAYER,
                             payerSignature: auth.signMessage(NONCE, attackerWif).signature };
            expect((await gw.verify(forged)).code).to.equal('X402_BAD_SIGNATURE');
        });

        it('dispenser: needs a valid challenge + payer signature; is one-time-use', async () => {
            const gw = mkGw({ send: null, dispenser: { holdTick: 'ACCESS', minBalance: '1', dispenserIndex: 42 } });
            explorer.getBalances.resolves({ data: [{ tick: 'ACCESS', amount: '5' }] });

            // No challenge at all.
            expect((await gw.verify({ x402Version: 1, scheme: 'xchain-dispenser', coin: 'TDOGE', payer: PAYER }, '/r')).code)
                .to.equal('X402_CHALLENGE_MISSING');

            // Proper flow: get the server challenge, sign it.
            const body = await gw.challengeBody('/r');
            const offer = body.accepts.find((a) => a.scheme === 'xchain-dispenser');
            const proof = { x402Version: 1, scheme: 'xchain-dispenser', coin: 'TDOGE', payer: PAYER,
                            challenge: offer.challenge, payerSignature: auth.signMessage(offer.challenge, WIF).signature };
            expect((await gw.verify(proof, '/r')).ok).to.equal(true);
            // Replay of the same challenge is refused.
            expect((await gw.verify(proof, '/r')).code).to.equal('X402_CHALLENGE_REPLAYED');
        });

        it('dispenser: an attacker naming the victim address but signing their own key is rejected', async () => {
            const gw = mkGw({ send: null, dispenser: { holdTick: 'ACCESS', minBalance: '1' } });
            explorer.getBalances.resolves({ data: [{ tick: 'ACCESS', amount: '5' }] });
            const body = await gw.challengeBody('/r');
            const offer = body.accepts.find((a) => a.scheme === 'xchain-dispenser');
            const forged = { x402Version: 1, scheme: 'xchain-dispenser', coin: 'TDOGE', payer: PAYER,
                             challenge: offer.challenge, payerSignature: auth.signMessage(offer.challenge, attackerWif).signature };
            expect((await gw.verify(forged, '/r')).code).to.equal('X402_BAD_SIGNATURE');
        });

        it('dispenser: a challenge issued for another resource does not verify', async () => {
            const gw = mkGw({ send: null, dispenser: { holdTick: 'ACCESS', minBalance: '1' } });
            explorer.getBalances.resolves({ data: [{ tick: 'ACCESS', amount: '5' }] });
            const body = await gw.challengeBody('/other');
            const offer = body.accepts.find((a) => a.scheme === 'xchain-dispenser');
            const proof = { x402Version: 1, scheme: 'xchain-dispenser', coin: 'TDOGE', payer: PAYER,
                            challenge: offer.challenge, payerSignature: auth.signMessage(offer.challenge, WIF).signature };
            expect((await gw.verify(proof, '/r')).code).to.equal('X402_CHALLENGE_RESOURCE_MISMATCH');
        });

        it('deposit: unsigned proof cannot debit another payer; a signed one debits', async () => {
            const gw = mkGw({ send: null, deposit: { tick: 'TOK', depositAddress: 'depAddr', pricePerCall: '4' } });
            explorer.getSends.resolves({ data: [{ source: PAYER, destination: 'depAddr', tick: 'TOK', amount: '10', memo: '', status: 'valid', tx_hash: 'd1' }] });

            const unsigned = { x402Version: 1, scheme: 'xchain-deposit', coin: 'TDOGE', payer: PAYER };
            expect((await gw.verify(unsigned, '/r')).code).to.equal('X402_CHALLENGE_MISSING');

            const body = await gw.challengeBody('/r');
            const offer = body.accepts.find((a) => a.scheme === 'xchain-deposit');
            const proof = { x402Version: 1, scheme: 'xchain-deposit', coin: 'TDOGE', payer: PAYER,
                            challenge: offer.challenge, payerSignature: auth.signMessage(offer.challenge, WIF).signature };
            expect((await gw.verify(proof, '/r')).ok).to.equal(true);
        });

        it('X402Client.buildSignedProof produces a dispenser proof the gateway accepts', async () => {
            const gw = mkGw({ send: null, dispenser: { holdTick: 'ACCESS', minBalance: '1' } });
            explorer.getBalances.resolves({ data: [{ tick: 'ACCESS', amount: '5' }] });
            const body = await gw.challengeBody('/r');
            const offer = body.accepts.find((a) => a.scheme === 'xchain-dispenser');
            const session = { address: PAYER, wif: WIF, sdk: { options: { network: NET } } };
            const header = X402Client.buildSignedProof(offer, session);
            const proof = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
            expect((await gw.verify(proof, '/r')).ok).to.equal(true);
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

        it('signs the invoice for a requireSignature send offer and the gateway accepts it end-to-end', async () => {
            const { ECPairFactory } = require('ecpair');
            const ecc = require('@bitcoinerlab/secp256k1');
            const { getNetwork } = require('../../src/networks.js');
            const AuthUtils = require('../../src/auth.js');
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

    it('exports are wired into the SDK entry point', () => {
        const sdkIndex = require('../../index.js');
        expect(sdkIndex.X402Gateway).to.be.a('function');
        expect(sdkIndex.X402Client).to.be.a('function');
        expect(sdkIndex.SDKX402Error).to.equal(SDKX402Error);
    });
});
