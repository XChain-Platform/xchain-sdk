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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const {
    expectedMismatch,
    fetchJson,
    pinnedEntry
} = require('../../../../src/protocol/light_client/fetch_helpers.js');

describe('pinnedEntry', function () {
    it('returns null when the caller supplies validators or a trusted checkpoint', function () {
        let calls = 0;
        const pinnedResolver = function () { calls++; return { checkpoint: {} }; };

        expect(pinnedEntry({ validators: [], pinnedResolver })).to.equal(null);
        expect(pinnedEntry({ trustedCheckpoint: {}, pinnedResolver })).to.equal(null);
        expect(calls).to.equal(0);
    });

    it('uses opts.coin by default and an explicit coin when supplied', function () {
        const seen = [];
        const pinnedResolver = function (coin) { seen.push(coin); return { coin }; };
        const opts = { coin: 'BTC', pinnedResolver };

        expect(pinnedEntry(opts)).to.deep.equal({ coin: 'BTC' });
        expect(pinnedEntry(opts, 'LTC')).to.deep.equal({ coin: 'LTC' });
        expect(seen).to.deep.equal(['BTC', 'LTC']);
    });

    it('normalizes a falsy resolver result to null', function () {
        expect(pinnedEntry({ coin: 'BTC', pinnedResolver: () => undefined })).to.equal(null);
    });
});

describe('fetchJson', function () {
    it('passes the URL to fetch and returns the parsed response body', async function () {
        const body = { height: 42 };
        let requestedUrl;
        const f = async function (url) {
            requestedUrl = url;
            return { ok: true, json: async function () { return body; } };
        };

        expect(await fetchJson(f, 'https://explorer.example/checkpoint')).to.equal(body);
        expect(requestedUrl).to.equal('https://explorer.example/checkpoint');
    });

    it('throws the response status for a failed request', async function () {
        let error;
        try {
            await fetchJson(async function () { return { ok: false, status: 503 }; }, '/checkpoint');
        } catch (cause) {
            error = cause;
        }

        expect(error).to.be.an('error');
        expect(error.message).to.equal('LightClient: explorer returned HTTP 503');
    });
});

describe('expectedMismatch', function () {
    it('returns null when expected is null', function () {
        expect(expectedMismatch(null, { address: 'actual' })).to.equal(null);
    });

    it('returns null when every expected field matches', function () {
        const expected = { address: 'same', tick: 'DOGE' };
        expect(expectedMismatch(expected, { address: 'same', tick: 'DOGE' })).to.equal(null);
    });

    it('skips fields whose expected value is undefined', function () {
        const expected = { address: undefined, tick: 'DOGE' };
        expect(expectedMismatch(expected, { address: 'different', tick: 'DOGE' })).to.equal(null);
    });

    it('returns the first mismatched field', function () {
        const expected = { address: 'wanted', tick: 'DOGE' };
        expect(expectedMismatch(expected, { address: 'other', tick: 'BTC' })).to.equal('address');
    });

    it('compares expected and actual values as strings', function () {
        expect(expectedMismatch({ contract_index: 5 }, { contract_index: '5' })).to.equal(null);
    });

    it('throws a TypeError naming a null expected field', function () {
        const call = () => expectedMismatch({ address: null }, { address: 'actual' });
        expect(call).to.throw(TypeError, 'expected.address');
    });
});
