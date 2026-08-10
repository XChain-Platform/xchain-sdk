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
 * XChain SDK - Attestation Framework Helpers
 *
 * Convenience builders for the External Attestation Framework. Contract
 * authors pass the output of these builders into
 * `xchain.attestation.request(providerId, payload, callbackMethod, callbackParams, options)`
 * inside their contract code.
 *
 * NOTE on `callbackParams`: every element is delivered to the callback as a
 * string by the VM, regardless of the type you pass (the parameter bus is
 * string-typed). Passing `[42, true, null]` yields `['42', 'true', 'null']`
 * at the callback. Re-parse numeric/boolean context inside the callback with
 * parseInt / parseFloat / JSON.parse. See the ATTEST spec §Effects.
 *
 * Spec: claude/reports/specs/2026-05-24_external-attestation-framework.md
 * LLM:  claude/reports/specs/2026-05-24_llm-attestation-provider.md
 *
 ********************************************************************/

const net = require('net');

// Deterministic, no-DNS SSRF gate for IP-literal hosts. Mirrors the hub
// provider's isForbiddenAddress (xchain-hub/src/providers/http_get.js) so the
// SDK helper rejects the same private/loopback/CGNAT/link-local/multicast
// literals client-side, before an ATTEST request is emitted on-chain. DNS
// hostnames are intentionally NOT resolved here (that stays the hub's job);
// only IP literals are checked.
function _isForbiddenAddress(addr){
    let ip = String(addr).toLowerCase();
    if (ip.startsWith('::ffff:')){
        const rest = ip.slice(7);
        if (net.isIPv4(rest)) ip = rest;
        else return true;
    }
    if (net.isIPv4(ip)){
        const o = ip.split('.').map(Number);
        if (o[0] === 0)   return true;                             // 0.0.0.0/8
        if (o[0] === 10)  return true;                             // 10/8 private
        if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true; // 100.64/10 CGNAT
        if (o[0] === 127) return true;                             // loopback
        if (o[0] === 169 && o[1] === 254) return true;             // link-local / metadata
        if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true; // 172.16/12 private
        if (o[0] === 192 && o[1] === 0 && o[2] === 0) return true; // 192.0.0.0/24 reserved
        if (o[0] === 192 && o[1] === 168) return true;             // 192.168/16 private
        if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return true; // 198.18/15 benchmarking
        if (o[0] >= 224) return true;                              // multicast/reserved/broadcast
        return false;
    }
    if (net.isIPv6(ip)){
        if (ip === '::' || ip === '::1') return true;              // unspecified / loopback
        if (ip.startsWith('::')) return true;                      // v4-compatible / embedded
        if (ip.startsWith('64:ff9b:')) return true;               // NAT64
        if (/^f[cd]/.test(ip))   return true;                     // fc00::/7 unique-local
        if (/^fe[89ab]/.test(ip)) return true;                    // fe80::/10 link-local
        if (/^ff/.test(ip))      return true;                     // multicast
        return false;
    }
    return true; // unparseable literal: fail closed
}

// Build an LLM provider request envelope as a JSON string. The format
// matches the provider's expected envelope (LLM spec §4): a top-level
// JSON object with `prompt` (required) and optional `system`, `max_tokens`,
// `format` ('text' | 'json_object'), `temperature`, `envelope_version`,
// `fallback` ('any' | 'strict').
//
// This helper does the validation up-front (size vs the llm provider's
// 8192-byte max_request_bytes, format enum, fallback enum, envelope_version
// ceiling) so the developer gets a clear error before the on-chain ATTEST v0
// (request) is emitted, mirroring buildHttpGetPayload's fail-early contract
// below.
//
// `maxTokens` is a CEILING, never a target, and it can only ever LOWER the
// completion budget. The hub applies `Math.min(envelope.max_tokens, <governance
// ceiling>)` (providers/llm.js), where the ceiling is governance-injected
// (max_completion_tokens, default 1024). Asking for MORE than the governance
// ceiling is silently clamped down to it: no error, no wire signal. So a value
// above the ceiling is a no-op, and a value below it is a real reduction. The
// SDK validates that maxTokens is a positive integer and that temperature is
// a finite number, but deliberately does not enforce any upper ceiling on
// maxTokens, because the ceiling is governance config the SDK cannot see;
// treat it as "cap my spend at N", not as "give me N tokens of output".
const LLM_MAX_REQUEST_BYTES = 8192;
// Must track the hub's published prompt_envelope_version (1 today). Any
// opts.envelopeVersion above this ceiling is rejected before the envelope
// is built.
const LLM_MAX_ENVELOPE_VERSION = 1;

function buildLlmEnvelope(opts){
    if (!opts || typeof opts.prompt !== 'string' || opts.prompt.length === 0){
        throw new Error('AttestationHelpers.llm: opts.prompt (non-empty string) is required');
    }
    if (opts.format !== undefined && opts.format !== 'text' && opts.format !== 'json_object'){
        throw new Error('AttestationHelpers.llm: opts.format must be "text" or "json_object"');
    }
    if (opts.fallback !== undefined && opts.fallback !== 'any' && opts.fallback !== 'strict'){
        throw new Error('AttestationHelpers.llm: opts.fallback must be "any" or "strict"');
    }
    let envelopeVersion;
    if (opts.envelopeVersion !== undefined){
        envelopeVersion = Number(opts.envelopeVersion);
        if (!Number.isFinite(envelopeVersion) || !Number.isInteger(envelopeVersion) ||
            envelopeVersion <= 0 || envelopeVersion > LLM_MAX_ENVELOPE_VERSION){
            throw new Error('AttestationHelpers.llm: opts.envelopeVersion must be a positive integer <= ' + LLM_MAX_ENVELOPE_VERSION);
        }
    }
    let maxTokens;
    if (opts.maxTokens !== undefined){
        maxTokens = Number(opts.maxTokens);
        if (!Number.isInteger(maxTokens) || maxTokens <= 0){
            throw new Error('AttestationHelpers.llm: opts.maxTokens must be a positive integer');
        }
    }
    let temperature;
    if (opts.temperature !== undefined){
        temperature = Number(opts.temperature);
        if (!Number.isFinite(temperature)){
            throw new Error('AttestationHelpers.llm: opts.temperature must be a finite number');
        }
        // Mirror the hub's FIXED [0,2] admission gate (providers/llm.js). Unlike
        // the max_tokens ceiling above, that bound is a constant rather than
        // governance-injected, so the SDK can enforce it and still be right.
        // Without it an out-of-range value builds a valid envelope, pays for the
        // on-chain ATTEST v0 request, and is then refused by every validator's
        // fetch, so the round never reaches quorum and expires. The tighter
        // per-vendor bound stays the hub's job: it depends on the block-anchored
        // pinned model the SDK cannot see.
        if (temperature < 0 || temperature > 2){
            throw new Error('AttestationHelpers.llm: opts.temperature must be a number in [0, 2]');
        }
    }
    let env = { prompt: opts.prompt };
    if (opts.system           !== undefined) env.system           = String(opts.system);
    if (opts.maxTokens        !== undefined) env.max_tokens       = maxTokens;
    if (opts.format           !== undefined) env.format           = String(opts.format);
    if (opts.temperature      !== undefined) env.temperature      = temperature;
    if (opts.envelopeVersion  !== undefined) env.envelope_version = envelopeVersion;
    if (opts.fallback         !== undefined) env.fallback         = String(opts.fallback);
    let json = JSON.stringify(env);
    if (Buffer.byteLength(json, 'utf8') > LLM_MAX_REQUEST_BYTES){
        throw new Error('AttestationHelpers.llm: envelope exceeds ' + LLM_MAX_REQUEST_BYTES + '-byte llm max_request_bytes');
    }
    return json;
}

// Validate + normalize an http_get URL. The provider enforces three admission
// gates and this helper mirrors all three up-front so the developer gets a
// clear error before the on-chain ATTEST v0 (request) is emitted (and before
// gas/fees are spent on a request every validator would reject):
//   1. https:// only
//   2. max_request_bytes (2048)
//   3. IP-literal SSRF gate: private/loopback/CGNAT/link-local/multicast
//      literals are refused (matching the hub's isForbiddenAddress). DNS
//      hostnames are NOT resolved here -- the hub stays authoritative for
//      those. Pass opts.allowPrivate:true to skip the literal check (mirrors
//      the hub's ATTESTATION_HTTP_GET_ALLOW_PRIVATE=1 escape hatch for
//      regtest/e2e).
function buildHttpGetPayload(opts){
    let url = (typeof opts === 'string') ? opts : (opts && opts.url);
    let allowPrivate = (typeof opts === 'object' && opts) ? opts.allowPrivate === true : false;
    if (!url || typeof url !== 'string'){
        throw new Error('AttestationHelpers.httpGet: opts.url (string) or string URL is required');
    }
    if (!/^https:\/\//i.test(url)){
        throw new Error('AttestationHelpers.httpGet: only https:// URLs are allowed');
    }
    let parsed;
    try {
        parsed = new URL(url);
    } catch (_err){
        throw new Error('AttestationHelpers.httpGet: URL is not a valid https:// URL');
    }
    if (!parsed.host){
        throw new Error('AttestationHelpers.httpGet: URL is not a valid https:// URL');
    }
    if (Buffer.byteLength(url, 'utf8') > 2048){
        throw new Error('AttestationHelpers.httpGet: URL exceeds 2048-byte http_get max_request_bytes');
    }
    // Only IP-literal hosts are checked; DNS names pass through to the hub.
    // URL.hostname keeps brackets around IPv6 literals ([::1]); strip them so
    // net.isIP recognizes the literal.
    let host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (!allowPrivate && net.isIP(host) && _isForbiddenAddress(host)){
        throw new Error('AttestationHelpers.httpGet: refusing non-public address ' + host + ' (SSRF guard); pass { allowPrivate: true } for regtest/e2e');
    }
    return url;
}

// Resolve a callback options object to the shape the VM gateway expects
// (`{ redundancy, deadlineBlocks, feeTick, feeAmount }`). Kept here so the
// helper layer is the single place defaults can change.
//
// feeTick/feeAmount (E1 paid attestations) travel as STRINGS; feeAmount is a
// non-negative decimal string with at most 8 decimal places (a practical
// ceiling; the chain's true cap is min(8, gasDecimals)), never a float, and
// feeTick is required when feeAmount is greater than 0. v1 consensus accepts
// only feeTick == 'XCHAIN'; the fields exist on the wire so multi-tick support
// is a post-launch rule loosening, not a format change. Validation of these
// constraints happens downstream in the VM gateway; this helper intentionally
// passes them through unchanged.
//
// Note: per-provider `max_response_bytes` is governance state on the
// provider registry, not a per-request override. The VM gateway ignores
// any extra keys, so this helper deliberately only surfaces the four
// fields the gateway actually reads.
function buildRequestOptions(opts){
    opts = opts || {};
    let out = {};
    if (opts.redundancy     !== undefined) out.redundancy     = Number(opts.redundancy);
    if (opts.deadlineBlocks !== undefined) out.deadlineBlocks = Number(opts.deadlineBlocks);
    if (opts.feeTick        !== undefined) out.feeTick        = String(opts.feeTick);
    if (opts.feeAmount      !== undefined) out.feeAmount      = String(opts.feeAmount);
    return out;
}

module.exports = {
    llm:            buildLlmEnvelope,
    httpGet:        buildHttpGetPayload,
    requestOptions: buildRequestOptions
};
