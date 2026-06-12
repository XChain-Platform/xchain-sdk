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

// Build an LLM provider request envelope as a JSON string. The format
// matches the provider's expected envelope (LLM spec §4): a top-level
// JSON object with `prompt` (required) and optional `system`, `max_tokens`,
// `format` ('text' | 'json_object'), `temperature`, `envelope_version`.
function buildLlmEnvelope(opts){
    if (!opts || typeof opts.prompt !== 'string' || opts.prompt.length === 0){
        throw new Error('AttestationHelpers.llm: opts.prompt (non-empty string) is required');
    }
    let env = { prompt: opts.prompt };
    if (opts.system           !== undefined) env.system           = String(opts.system);
    if (opts.maxTokens        !== undefined) env.max_tokens       = Number(opts.maxTokens);
    if (opts.format           !== undefined) env.format           = String(opts.format);
    if (opts.temperature      !== undefined) env.temperature      = Number(opts.temperature);
    if (opts.envelopeVersion  !== undefined) env.envelope_version = Number(opts.envelopeVersion);
    return JSON.stringify(env);
}

// Validate + normalize an http_get URL. The provider only accepts
// https:// URLs and a per-provider max_request_bytes (default 2048).
// This helper does the validation up-front so the developer gets a clear
// error before the on-chain ATTEST v0 (request) is emitted.
function buildHttpGetPayload(opts){
    let url = (typeof opts === 'string') ? opts : (opts && opts.url);
    if (!url || typeof url !== 'string'){
        throw new Error('AttestationHelpers.httpGet: opts.url (string) or string URL is required');
    }
    if (!/^https:\/\//i.test(url)){
        throw new Error('AttestationHelpers.httpGet: only https:// URLs are allowed');
    }
    if (Buffer.byteLength(url, 'utf8') > 2048){
        throw new Error('AttestationHelpers.httpGet: URL exceeds 2048-byte http_get max_request_bytes');
    }
    return url;
}

// Resolve a callback options object to the shape the VM gateway expects
// (`{ redundancy, deadlineBlocks, feeTick, feeAmount }`). Kept here so the
// helper layer is the single place defaults can change.
//
// feeTick/feeAmount (E1 paid attestations) travel as STRINGS — amounts are
// arbitrary-precision decimals, never floats. v1 consensus accepts only
// feeTick == 'XCHAIN'; the fields exist on the wire so multi-tick support
// is a post-launch rule loosening, not a format change.
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
