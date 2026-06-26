// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The co-signer toolkit must be reachable from the SDK's PUBLIC surface (the
// package exports + `sdk.coSigner`) so the wallet's passive co-signer builds on
// it without importing from src/. Guards against an accidental export regression.

'use strict';

const { expect } = require('chai');
const pkg = require('../../index.js');
const XChainSDK = require('../../src/XChainSDK.js');

const PUBLIC = [
    'CoSigner', 'CoSignerClient', 'deriveMuSig2P2TR', 'deriveMuSig2P2TR2of3',
    'buildMuSig2Signer', 'buildRecoverySpend', 'localPairSigner',
];

describe('co-signer public exports', function () {

    it('exposes the toolkit as named package exports', function () {
        for (const name of PUBLIC) expect(pkg[name], name).to.be.a('function');
        expect(pkg.coSigner).to.be.an('object');
        expect(pkg.coSigner.inProcessTransport).to.be.a('function');
    });

    it('exposes the same toolkit on a constructed SDK instance (sdk.coSigner)', function () {
        const sdk = new XChainSDK({ network: 'bitcoin-regtest' });
        expect(sdk.coSigner).to.be.an('object');
        for (const name of PUBLIC) expect(sdk.coSigner[name], name).to.be.a('function');
        // Same references as the package barrel (one source of truth).
        expect(sdk.coSigner.CoSigner).to.equal(pkg.CoSigner);
    });

    it('the public exports are actually wired (a derive round-trips)', function () {
        const crypto = require('crypto');
        const { secp256k1 } = require('@noble/curves/secp256k1');
        const a = Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true));
        const b = Buffer.from(secp256k1.getPublicKey(crypto.randomBytes(32), true));
        const acct = pkg.deriveMuSig2P2TR([a, b]);
        expect(acct.address).to.be.a('string');
        expect(acct.output).to.have.length(34);            // OP_1 <32-byte>
        // CoSigner constructs from the public export with a normalized policy.
        const co = new pkg.CoSigner({ secretKey: crypto.randomBytes(32),
            publicKeys: [a, b], policy: { allowedActions: new Set(['SEND']) } });
        expect(co).to.be.an.instanceof(pkg.CoSigner);
    });

    it('does NOT pull the Node-only sidecar into the public barrel', function () {
        // createCoSignerApp (express) stays a deep Node-only require; keeping it out
        // of the barrel is what keeps the toolkit safe for the browser bundle.
        expect(pkg.coSigner.createCoSignerApp).to.equal(undefined);
    });
});
