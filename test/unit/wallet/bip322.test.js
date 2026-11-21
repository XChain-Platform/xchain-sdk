// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { expect } = require('chai');
const AuthUtils = require('../../../src/utils/auth.js');
const bip322 = require('../../../src/utils/bip322.js');
const { getNetwork } = require('../../../src/protocol/networks.js');

const MAINNET = getNetwork('bitcoin-mainnet');
const VECTOR = {
    message: 'PURVOQ544B6HUATVBJZN5EZJUU',
    address: 'bc1pcquvhrqv0q68t4m0hfq6tpn006qrskyc7yrqnp2uyrf2emg3wynsdjyk38',
    signature: 'smpAUB6B2Rbupzua8LTQIF06516wzl+cwKy1be8RgoiW0riyXdKwe6GTz/5Hnb37m67pJwIKCh+D5jDueG6KpvYpmu8'
};
const FALLBACK_VECTOR = {
    message: 'No prefix fallback',
    wif: 'KyrSGCFPhqZMjCe5fNTYddiLMp4tMj4gLKuJ26TsB2rvr1VJGPbt',
    address: 'bc1pss0zhytly75awhm6x2hhvd5lnzv3vssgrf9axfheq8ldyzn88ges79fler',
    signature: 'AUCJYOwOjxYAvatTAGYaVlNXBVyFuc4MwNQkOuK2tl8xhfKDONd0NjfYyNSYcRqeCp8hsAnCEPHAVEkO9h6vbQ/R'
};

describe('BIP-322 simple P2TR messages', function() {
    it('verifies the published prefixed P2TR vector', function() {
        expect(bip322.verifySimple(VECTOR.address, VECTOR.message, VECTOR.signature, MAINNET)).to.equal(true);
    });

    it('verifies the published no-prefix compatibility vector', function() {
        expect(bip322.verifySimple(
            FALLBACK_VECTOR.address,
            FALLBACK_VECTOR.message,
            FALLBACK_VECTOR.signature,
            MAINNET
        )).to.equal(true);
    });

    it('matches the published UTF-8 message hash', function() {
        expect(bip322.messageHash('Hello World').toString('hex'))
            .to.equal('f0eb03b1a75ac6d9847f55c624a99169b5dccba2a31f5b23bea77ba270de0a7a');
    });

    it('signs deterministically when auxiliary randomness is fixed', function() {
        const auth = new AuthUtils('bitcoin-mainnet');
        const signed = auth.signMessage(FALLBACK_VECTOR.message, FALLBACK_VECTOR.wif, {
            format: 'bip322-simple',
            auxRand: Buffer.alloc(32)
        });

        expect(signed).to.deep.equal({
            address: FALLBACK_VECTOR.address,
            signature: 'smpAUCCbYAftMlgtSzWZ+UyuIKyXuR8TnBQ1jXVqq3VesZRdLDeurgSpBgZHD3dbq3rJRQXvji4KyP7ah+1dl444Q3+'
        });
        expect(auth.verifyMessage(signed.address, FALLBACK_VECTOR.message, signed.signature, {
            format: 'bip322-simple'
        })).to.deep.equal({ valid: true, error: null });
    });

    it('rejects message, signer, signature and format changes', function() {
        expect(bip322.verifySimple(VECTOR.address, 'wrong message', VECTOR.signature, MAINNET)).to.equal(false);
        expect(bip322.verifySimple(FALLBACK_VECTOR.address, VECTOR.message, VECTOR.signature, MAINNET))
            .to.equal(false);
        expect(bip322.verifySimple(VECTOR.address, VECTOR.message, VECTOR.signature.slice(0, -1), MAINNET))
            .to.equal(false);
        expect(bip322.verifySimple(VECTOR.address, VECTOR.message, 'fulAA==', MAINNET)).to.equal(false);
    });

    it('returns a structured auth failure without throwing', function() {
        const auth = new AuthUtils('bitcoin-mainnet');
        expect(auth.verifyOwnership(VECTOR.address, VECTOR.message, 'smpAA==', undefined, {
            format: 'bip322-simple'
        })).to.deep.equal({
            valid: false,
            address: VECTOR.address,
            error: 'Invalid BIP-322 simple signature.'
        });
    });

    it('refuses incompatible and unknown signing formats', function() {
        const auth = new AuthUtils('bitcoin-mainnet');
        expect(() => auth.signMessage(VECTOR.message, FALLBACK_VECTOR.wif, {
            format: 'bip322-simple',
            segwitNative: true
        })).to.throw().with.property('code', 'INVALID_SIGNATURE_FORMAT');
        expect(() => auth.signMessage(VECTOR.message, FALLBACK_VECTOR.wif, { format: 'unknown' }))
            .to.throw().with.property('code', 'INVALID_SIGNATURE_FORMAT');
    });

    it('refuses BIP-322 signing on a non-SegWit network', function() {
        expect(() => new AuthUtils('dogecoin-mainnet').signMessage(
            VECTOR.message,
            FALLBACK_VECTOR.wif,
            { format: 'bip322-simple' }
        )).to.throw().with.property('code', 'SEGWIT_NOT_SUPPORTED');
    });
});
