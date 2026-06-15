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
 * XChain Platform SDK - Contract Utilities
 *
 * Authoring helpers for VM smart contracts: base64 encoding, syntax
 * validation, float detection, code size checks, gas estimation.
 *
 * These are pure functions with no dependency on isolated-vm.
 *
 * validate() / checkFloatUsage() delegate to ./contract/lint-core.js — a
 * BYTE-IDENTICAL vendored copy of xchain-vm/src/lint-core.js — so the SDK's
 * pre-flight verdict matches the indexer's deploy-time validation exactly
 * (no false greens). A CI parity guard (sha256) fails the build on drift.
 * lint-core pulls acorn/acorn-walk/astring (pure JS, browser-safe; now hard
 * deps), never isolated-vm.
 *
 ********************************************************************/

const { SDKContractError } = require('./errors.js');
const { lintSource, findFloatWarnings } = require('./contract/lint-core.js');

// 64KB contract source code limit — canonical value in
// xchain-documentation/protocol/constants.js (MAX_CODE_SIZE), also enforced by
// the SDK validator, the indexer (DEPLOY) and the VM isolate limit.
const MAX_CODE_SIZE = 65536;

// Lazy-loaded optional dependencies
let acorn = null;
let acornWalk = null;

function loadAcorn() {
    if (acorn === null) {
        try {
            acorn = require('acorn');
        } catch (e) {
            acorn = false;
        }
    }
    return acorn;
}

function loadAcornWalk() {
    if (acornWalk === null) {
        try {
            acornWalk = require('acorn-walk');
        } catch (e) {
            acornWalk = false;
        }
    }
    return acornWalk;
}


class ContractUtils {

    // base64-encode UTF-8 contract source code for DEPLOY payloads (1.33x vs hex's 2x;
    // base64's alphabet has no '|' so it is safe in the pipe-delimited action string).
    encode(sourceCode) {
        if (typeof sourceCode !== 'string')
            throw new SDKContractError('CODE_ENCODING_FAILED', 'Contract source must be a string');
        return Buffer.from(sourceCode, 'utf8').toString('base64');
    }

    // base64-decode back to UTF-8 source for inspection
    decode(b64String) {
        if (typeof b64String !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64String))
            throw new SDKContractError('CODE_ENCODING_FAILED', 'Invalid base64 string');
        return Buffer.from(b64String, 'base64').toString('utf8');
    }

    // Pre-flight syntax/rule validation (no V8 / isolated-vm required). Runs every
    // acorn-coverable deploy check via the vendored lint-core (deploy parity), so a
    // valid result here means the contract clears the indexer's syntax gate too —
    // EXCEPT the V8-only step-1 compile, which can only run at deploy/CLI.
    // Returns { valid, error?, warnings? } (back-compat shape; error = first error).
    validate(sourceCode) {
        if (typeof sourceCode !== 'string')
            return { valid: false, error: 'Contract source must be a string' };

        // Check code size first (SDK-side guard; mirrors MAX_CODE_SIZE)
        let sizeCheck = this.checkCodeSize(sourceCode);
        if (!sizeCheck.withinLimit)
            return { valid: false, error: 'Contract code exceeds ' + MAX_CODE_SIZE + ' byte limit (' + sizeCheck.bytes + ' bytes)' };

        let { errors, warnings } = lintSource(sourceCode);
        let warns = warnings.map((w) => w.message);
        if (errors.length > 0)
            return { valid: false, error: errors[0].message, warnings: warns.length > 0 ? warns : undefined };

        return { valid: true, warnings: warns.length > 0 ? warns : undefined };
    }

    // Detect float literal usage in contract source. Delegates to the vendored
    // lint-core so the warning text matches the VM / deploy path exactly.
    // Returns array of warning strings.
    checkFloatUsage(sourceCode) {
        if (typeof sourceCode !== 'string') return [];
        return findFloatWarnings(sourceCode).map((w) => w.message);
    }

    // Check if contract source is within the 64KB byte limit
    checkCodeSize(sourceCode) {
        let bytes = Buffer.byteLength(String(sourceCode), 'utf8');
        return {
            bytes: bytes,
            withinLimit: bytes <= MAX_CODE_SIZE,
            limit: MAX_CODE_SIZE
        };
    }

    // Count C-style `for (init; test; update)` statements — the loops the VM
    // double-charges per iteration (body + update expression). for-in / for-of /
    // while / do-while have no update slot and are excluded. Prefers an AST walk;
    // degrades to a header-shape regex when acorn is unavailable.
    _countForStatements(sourceCode) {
        let code = String(sourceCode);
        let parser = loadAcorn();
        let walker = loadAcornWalk();
        if (parser && walker) {
            try {
                let ast = parser.parse(code, { ecmaVersion: 2020, sourceType: 'script', locations: false });
                let count = 0;
                walker.simple(ast, { ForStatement() { count++; } });
                return count;
            } catch (e) {
                // Unparseable source — fall through to the regex approximation.
            }
        }
        // Fallback: a C-style `for` header contains semicolons; for-in / for-of
        // headers do not. Match `for (` up to the first `;` in the header.
        return (code.match(/\bfor\s*\([^;{)]*;/g) || []).length;
    }

    // Heuristic gas limit suggestion based on code size and complexity
    suggestGasLimit(sourceCode) {
        let code = String(sourceCode);
        let bytes = Buffer.byteLength(code, 'utf8');

        // Base cost: deployment overhead
        let base = 50000;

        // Per-byte cost for code storage
        let perByte = bytes * 10;

        // Complexity heuristics
        let loops = (code.match(/\b(for|while|do)\b/g) || []).length;
        let functions = (code.match(/\bfunction\b/g) || []).length;
        let emits = (code.match(/xchain\.emit\./g) || []).length;
        let stateOps = (code.match(/xchain\.state\./g) || []).length;

        // Indexed `for` loops cost ~2x per iteration vs while / do-while / for-in /
        // for-of. The VM's gas-metering transform injects a charge for BOTH the loop
        // body AND the update expression — `for (...; i++)` is metered as
        // `for (...; (__gas(1), i++))` — so each iteration is charged twice. Loops
        // without an update slot are charged once. Count each C-style `for` an extra
        // time so its estimated budget reflects the doubled charge.
        let forLoops = this._countForStatements(code);

        let complexity = ((loops + forLoops) * 20000) + (functions * 5000) + (emits * 5000) + (stateOps * 2000);

        let suggested = base + perByte + complexity;

        // Round up to nearest 10000
        suggested = Math.ceil(suggested / 10000) * 10000;

        // Cap at reasonable ceiling
        if (suggested > 1000000) suggested = 1000000;

        let rationale = bytes + ' bytes, ' + functions + ' functions, ' + loops + ' loops (' +
            forLoops + ' indexed for, charged 2x/iteration), ' +
            emits + ' emit calls, ' + stateOps + ' state ops';

        return { suggested, rationale };
    }

}

module.exports = ContractUtils;
