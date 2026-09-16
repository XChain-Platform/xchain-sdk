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
const { ECPairFactory } = require('ecpair');
const ecc = require('@bitcoinerlab/secp256k1');

const { X402Gateway, X402Client } = require('../../../../src/utils/x402.js');
const { getNetwork } = require('../../../../src/protocol/networks.js');
const AuthUtils = require('../../../../src/utils/auth.js');

const NONCE = 'a'.repeat(32);
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

function setupGateway() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x402sig-'));
    explorer = {
        getSends:    sinon.stub().resolves({ data: [] }),
        getMempool:  sinon.stub().resolves({ data: [] }),
        getBalances: sinon.stub().resolves({ data: [] }),
        getAddress:  sinon.stub().resolves({ info: { address_id: 3 } }),
        getToken:    sinon.stub().resolves({ info: { tick_id: 7 } }),
    };
}

describe('x402', () => {
    /* ── payer-signature binding (default: requireSignature ON) ─────── */

    describe('X402Gateway payer-signature binding', () => {
        beforeEach(setupGateway);
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
    });
});

describe('x402', () => {
    describe('X402Gateway payer-signature binding', () => {
        beforeEach(setupGateway);
        afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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
    });
});

describe('x402', () => {
    describe('X402Gateway payer-signature binding', () => {
        beforeEach(setupGateway);
        afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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

        it('dispenser: a challenge whose MAC is tampered with or truncated is rejected', async () => {
            const gw = mkGw({ send: null, dispenser: { holdTick: 'ACCESS', minBalance: '1' } });
            explorer.getBalances.resolves({ data: [{ tick: 'ACCESS', amount: '5' }] });
            const body = await gw.challengeBody('/r');
            const offer = body.accepts.find((a) => a.scheme === 'xchain-dispenser');
            const dot = offer.challenge.lastIndexOf('.');
            const payload = offer.challenge.slice(0, dot);
            const mac = offer.challenge.slice(dot + 1);

            // (a) one hex character of the MAC flipped: same length, wrong MAC.
            const flipped = payload + '.' + mac.slice(0, -1) + (mac.slice(-1) === 'a' ? 'b' : 'a');
            // (b) MAC truncated by a few characters: shorter, wrong MAC.
            const truncated = payload + '.' + mac.slice(0, -4);

            for (const challenge of [flipped, truncated]) {
                // Signed over the tampered token, so the challenge MAC check is what
                // rejects it (it runs before the payload is parsed or the signature
                // is checked), not a signature mismatch.
                const proof = { x402Version: 1, scheme: 'xchain-dispenser', coin: 'TDOGE', payer: PAYER,
                                challenge, payerSignature: auth.signMessage(challenge, WIF).signature };
                expect((await gw.verify(proof, '/r')).code).to.equal('X402_BAD_CHALLENGE');
            }
        });
    });
});

describe('x402', () => {
    describe('X402Gateway payer-signature binding', () => {
        beforeEach(setupGateway);
        afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

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
});
