/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain Platform SDK - AttestationHelpers Tests
 *
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const Attestation = require('../../src/attestation.js');

describe('AttestationHelpers.llm', function () {

    it('builds a JSON envelope with only required prompt', function () {
        const out = Attestation.llm({ prompt: 'Hello world' });
        expect(out).to.be.a('string');
        const parsed = JSON.parse(out);
        expect(parsed).to.deep.equal({ prompt: 'Hello world' });
    });

    it('passes through optional system + max_tokens + format + temperature', function () {
        const out = Attestation.llm({
            prompt: 'q?',
            system: 'be concise',
            maxTokens: 256,
            format: 'json_object',
            temperature: 0.7
        });
        const parsed = JSON.parse(out);
        expect(parsed.prompt).to.equal('q?');
        expect(parsed.system).to.equal('be concise');
        expect(parsed.max_tokens).to.equal(256);
        expect(parsed.format).to.equal('json_object');
        expect(parsed.temperature).to.equal(0.7);
    });

    it('coerces maxTokens to Number', function () {
        const parsed = JSON.parse(Attestation.llm({ prompt: 'x', maxTokens: '512' }));
        expect(parsed.max_tokens).to.equal(512);
    });

    it('includes envelope_version when specified', function () {
        const parsed = JSON.parse(Attestation.llm({ prompt: 'x', envelopeVersion: 1 }));
        expect(parsed.envelope_version).to.equal(1);
    });

    it('throws when prompt is missing', function () {
        expect(() => Attestation.llm({})).to.throw(/prompt/);
    });

    it('throws when prompt is empty', function () {
        expect(() => Attestation.llm({ prompt: '' })).to.throw(/prompt/);
    });

    it('throws when prompt is not a string', function () {
        expect(() => Attestation.llm({ prompt: 123 })).to.throw(/prompt/);
    });

    it('throws when opts is null', function () {
        expect(() => Attestation.llm(null)).to.throw(/prompt/);
    });

    it('does not emit optional fields when undefined', function () {
        const parsed = JSON.parse(Attestation.llm({ prompt: 'x' }));
        expect(parsed).to.not.have.property('system');
        expect(parsed).to.not.have.property('max_tokens');
        expect(parsed).to.not.have.property('format');
        expect(parsed).to.not.have.property('temperature');
    });

});

describe('AttestationHelpers.httpGet', function () {

    it('accepts a string URL directly', function () {
        expect(Attestation.httpGet('https://example.com/x')).to.equal('https://example.com/x');
    });

    it('accepts an opts object with .url', function () {
        expect(Attestation.httpGet({ url: 'https://example.com/x' })).to.equal('https://example.com/x');
    });

    it('throws on http:// URL (only https allowed)', function () {
        expect(() => Attestation.httpGet('http://example.com/x')).to.throw(/https/);
    });

    it('throws on missing URL', function () {
        expect(() => Attestation.httpGet({})).to.throw(/url/);
        expect(() => Attestation.httpGet(null)).to.throw(/url/);
        expect(() => Attestation.httpGet(undefined)).to.throw(/url/);
    });

    it('throws when URL exceeds 2048-byte cap', function () {
        const longUrl = 'https://example.com/' + 'a'.repeat(2048);
        expect(() => Attestation.httpGet(longUrl)).to.throw(/2048/);
    });

    it('accepts URL at exactly 2048 bytes', function () {
        // 2048 bytes total: 'https://example.com/' is 20 chars; pad to 2048
        const pad = 2048 - 20;
        const url = 'https://example.com/' + 'a'.repeat(pad);
        expect(() => Attestation.httpGet(url)).to.not.throw();
    });

});

describe('AttestationHelpers.requestOptions', function () {

    it('returns empty object for empty input', function () {
        expect(Attestation.requestOptions()).to.deep.equal({});
        expect(Attestation.requestOptions({})).to.deep.equal({});
    });

    it('passes through redundancy + deadlineBlocks as numbers; ignores maxResponseBytes (governance state, not per-request)', function () {
        const out = Attestation.requestOptions({ redundancy: '3', deadlineBlocks: '10', maxResponseBytes: '1024' });
        expect(out).to.deep.equal({ redundancy: 3, deadlineBlocks: 10 });
    });

    it('ignores unrecognized keys', function () {
        const out = Attestation.requestOptions({ redundancy: 1, foo: 'bar' });
        expect(out).to.deep.equal({ redundancy: 1 });
        expect(out).to.not.have.property('foo');
    });

    it('passes through feeTick + feeAmount as STRINGS (amounts are decimals, never floats)', function () {
        const out = Attestation.requestOptions({ feeTick: 'XCHAIN', feeAmount: 2.5 });
        expect(out).to.deep.equal({ feeTick: 'XCHAIN', feeAmount: '2.5' });
        expect(out.feeAmount).to.be.a('string');
    });

    it('omits fee fields entirely when not provided (feeless wire format unchanged)', function () {
        const out = Attestation.requestOptions({ redundancy: 1 });
        expect(out).to.not.have.property('feeTick');
        expect(out).to.not.have.property('feeAmount');
    });

});
