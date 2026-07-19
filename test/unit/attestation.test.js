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
        expect(parsed).to.not.have.property('fallback');
    });

    it('emits fallback "strict" when provided', function () {
        const parsed = JSON.parse(Attestation.llm({ prompt: 'x', fallback: 'strict' }));
        expect(parsed.fallback).to.equal('strict');
    });

    it('emits fallback "any" when provided', function () {
        const parsed = JSON.parse(Attestation.llm({ prompt: 'x', fallback: 'any' }));
        expect(parsed.fallback).to.equal('any');
    });

    it('throws when fallback is not "any" or "strict"', function () {
        expect(() => Attestation.llm({ prompt: 'x', fallback: 'bogus' })).to.throw(/fallback/);
    });

    it('throws when format is not "text" or "json_object"', function () {
        expect(() => Attestation.llm({ prompt: 'x', format: 'json' })).to.throw(/format/);
    });

    it('throws when envelopeVersion is above the ceiling', function () {
        expect(() => Attestation.llm({ prompt: 'x', envelopeVersion: 2 })).to.throw(/envelopeVersion/i);
    });

    it('throws when envelopeVersion is NaN', function () {
        expect(() => Attestation.llm({ prompt: 'x', envelopeVersion: NaN })).to.throw(/envelopeVersion/i);
    });

    it('throws when envelopeVersion is a non-numeric string', function () {
        expect(() => Attestation.llm({ prompt: 'x', envelopeVersion: 'abc' })).to.throw(/envelopeVersion/i);
    });

    it('throws when envelopeVersion is 0', function () {
        expect(() => Attestation.llm({ prompt: 'x', envelopeVersion: 0 })).to.throw(/envelopeVersion/i);
    });

    it('throws when envelopeVersion is negative', function () {
        expect(() => Attestation.llm({ prompt: 'x', envelopeVersion: -1 })).to.throw(/envelopeVersion/i);
    });

    it('throws when envelopeVersion is fractional', function () {
        expect(() => Attestation.llm({ prompt: 'x', envelopeVersion: 1.5 })).to.throw(/envelopeVersion/i);
    });

    it('omits envelope_version when envelopeVersion is undefined', function () {
        const parsed = JSON.parse(Attestation.llm({ prompt: 'x', envelopeVersion: undefined }));
        expect(parsed).to.not.have.property('envelope_version');
    });

    it('throws when envelope exceeds the 8192-byte llm max_request_bytes', function () {
        const longPrompt = 'a'.repeat(8300);
        expect(() => Attestation.llm({ prompt: longPrompt })).to.throw(/8192/);
    });

    it('accepts an envelope at exactly the 8192-byte cap', function () {
        // Pad the prompt so the serialized envelope lands exactly at 8192 bytes.
        const overhead = JSON.stringify({ prompt: '' }).length;
        const prompt = 'a'.repeat(8192 - overhead);
        expect(() => Attestation.llm({ prompt })).to.not.throw();
        expect(Buffer.byteLength(Attestation.llm({ prompt }), 'utf8')).to.equal(8192);
    });

    it('throws when maxTokens is non-numeric ("512 tokens" would otherwise NaN -> null on the wire)', function () {
        expect(() => Attestation.llm({ prompt: 'x', maxTokens: '512 tokens' })).to.throw(/maxTokens/);
    });

    it('throws when maxTokens is negative', function () {
        expect(() => Attestation.llm({ prompt: 'x', maxTokens: -5 })).to.throw(/maxTokens/);
    });

    it('throws when maxTokens is fractional', function () {
        expect(() => Attestation.llm({ prompt: 'x', maxTokens: 100.5 })).to.throw(/maxTokens/);
    });

    it('throws when maxTokens is zero', function () {
        expect(() => Attestation.llm({ prompt: 'x', maxTokens: 0 })).to.throw(/maxTokens/);
    });

    it('still accepts maxTokens as a numeric string', function () {
        const parsed = JSON.parse(Attestation.llm({ prompt: 'x', maxTokens: '512' }));
        expect(parsed.max_tokens).to.equal(512);
    });

    it('throws when temperature is non-numeric ("low" would otherwise NaN -> null on the wire)', function () {
        expect(() => Attestation.llm({ prompt: 'x', temperature: 'low' })).to.throw(/temperature/);
    });

    it('throws when temperature is not finite', function () {
        expect(() => Attestation.llm({ prompt: 'x', temperature: Infinity })).to.throw(/temperature/);
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

    it('throws on a scheme-only URL with no host', function () {
        expect(() => Attestation.httpGet('https://')).to.throw();
    });

    it('throws on an https URL containing a space in the authority', function () {
        expect(() => Attestation.httpGet('https://exa mple.com/x')).to.throw();
    });

    it('returns the exact input string unchanged, not a normalized form', function () {
        const url = 'https://example.com/x';
        expect(Attestation.httpGet(url)).to.equal(url);
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
