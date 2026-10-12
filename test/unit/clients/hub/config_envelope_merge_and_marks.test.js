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
 * XChain Platform SDK - Hub Config Envelope Tests
 *
 * Unit tests for mergeConfigDelta, isHubErrorEnvelope and hubEnvelopeMarks.
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const {
    mergeConfigDelta,
    isHubErrorEnvelope,
    hubEnvelopeMarks
} = require('../../../../src/clients/hub/config_envelope.js');

describe('config_envelope mergeConfigDelta', function () {

    it('creates missing coin, network and module levels', function () {
        const base = {};
        mergeConfigDelta(base, { bitcoin: { mainnet: { rpc: { host: 'a' } } } });
        expect(base).to.deep.equal({ bitcoin: { mainnet: { rpc: { host: 'a' } } } });
    });

    it('overwrites existing params and keeps untouched ones', function () {
        const base = { bitcoin: { mainnet: { rpc: { host: 'a', port: 1 }, other: { k: 'v' } } } };
        mergeConfigDelta(base, { bitcoin: { mainnet: { rpc: { host: 'b' } } } });
        expect(base.bitcoin.mainnet.rpc).to.deep.equal({ host: 'b', port: 1 });
        expect(base.bitcoin.mainnet.other).to.deep.equal({ k: 'v' });
    });

    it('adds a sibling network without disturbing the existing one', function () {
        const base = { bitcoin: { mainnet: { rpc: { host: 'a' } } } };
        mergeConfigDelta(base, { bitcoin: { testnet: { rpc: { host: 't' } } } });
        expect(base.bitcoin.mainnet.rpc.host).to.equal('a');
        expect(base.bitcoin.testnet.rpc.host).to.equal('t');
    });

    it('mutates and returns base', function () {
        const base = {};
        const out = mergeConfigDelta(base, { litecoin: { regtest: { m: { p: 1 } } } });
        expect(out).to.equal(base);
        expect(base.litecoin.regtest.m.p).to.equal(1);
    });

    it('leaves base unchanged for an empty delta', function () {
        const base = { bitcoin: { mainnet: { rpc: { host: 'a' } } } };
        const out = mergeConfigDelta(base, {});
        expect(out).to.equal(base);
        expect(out).to.deep.equal({ bitcoin: { mainnet: { rpc: { host: 'a' } } } });
    });
});

describe('config_envelope isHubErrorEnvelope', function () {

    it('is true for an error-only result', function () {
        expect(isHubErrorEnvelope({ error: 'x' })).to.equal(true);
    });

    it('is false when configs is present', function () {
        expect(isHubErrorEnvelope({ error: 'x', configs: {} })).to.equal(false);
    });

    it('is false for an empty object, null and a string', function () {
        expect(isHubErrorEnvelope({})).to.equal(false);
        expect(isHubErrorEnvelope(null)).to.equal(false);
        expect(isHubErrorEnvelope('error')).to.equal(false);
    });
});

describe('config_envelope hubEnvelopeMarks', function () {

    const EMPTY = { seq: 0, watermark: null };

    it('returns zero marks without seq or without a configs object', function () {
        expect(hubEnvelopeMarks({ configs: {}, watermark: 5 })).to.deep.equal(EMPTY);
        expect(hubEnvelopeMarks({ seq: 3, watermark: 5 })).to.deep.equal(EMPTY);
        expect(hubEnvelopeMarks({ configs: 'x', seq: 3 })).to.deep.equal(EMPTY);
        expect(hubEnvelopeMarks(null)).to.deep.equal(EMPTY);
    });

    it('coerces numeric strings', function () {
        const marks = hubEnvelopeMarks({ configs: {}, seq: '4', watermark: '9' });
        expect(marks).to.deep.equal({ seq: 4, watermark: 9 });
    });

    it('returns a null watermark when null or absent', function () {
        expect(hubEnvelopeMarks({ configs: {}, seq: 2, watermark: null }))
            .to.deep.equal({ seq: 2, watermark: null });
        expect(hubEnvelopeMarks({ configs: {}, seq: 2 }))
            .to.deep.equal({ seq: 2, watermark: null });
    });

    it('maps a non-numeric seq or watermark to 0', function () {
        expect(hubEnvelopeMarks({ configs: {}, seq: 'abc', watermark: 'xyz' }))
            .to.deep.equal({ seq: 0, watermark: 0 });
    });
});
