/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain Platform SDK - Contract Utilities
 *
 * Authoring helpers for VM smart contracts: hex encoding, syntax
 * validation, float detection, code size checks, gas estimation.
 *
 * These are pure functions with no dependency on isolated-vm.
 * acorn/acorn-walk are optional — validate() and checkFloatUsage()
 * degrade gracefully when they are not installed.
 *
 ********************************************************************/

const { SDKContractError } = require('./errors.js');

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

    // Hex-encode UTF-8 contract source code for DEPLOY payloads
    encode(sourceCode) {
        if (typeof sourceCode !== 'string')
            throw new SDKContractError('CODE_ENCODING_FAILED', 'Contract source must be a string');
        return Buffer.from(sourceCode, 'utf8').toString('hex');
    }

    // Hex-decode back to UTF-8 source for inspection
    decode(hexString) {
        if (typeof hexString !== 'string' || !/^[0-9a-fA-F]*$/.test(hexString))
            throw new SDKContractError('CODE_ENCODING_FAILED', 'Invalid hex string');
        return Buffer.from(hexString, 'hex').toString('utf8');
    }

    // Lightweight syntax pre-validation using acorn (no V8 required)
    // Returns { valid, error?, warnings? }
    validate(sourceCode) {
        if (typeof sourceCode !== 'string')
            return { valid: false, error: 'Contract source must be a string' };

        // Check code size first
        let sizeCheck = this.checkCodeSize(sourceCode);
        if (!sizeCheck.withinLimit)
            return { valid: false, error: 'Contract code exceeds ' + MAX_CODE_SIZE + ' byte limit (' + sizeCheck.bytes + ' bytes)' };

        let parser = loadAcorn();
        if (!parser)
            return { valid: false, error: 'acorn is required for syntax validation. Install it with: npm install acorn' };

        try {
            parser.parse(sourceCode, { ecmaVersion: 2020, sourceType: 'script' });
        } catch (e) {
            return { valid: false, error: 'Syntax error: ' + e.message };
        }

        // Check for __gas reserved identifier
        if (/__gas\b/.test(sourceCode))
            return { valid: false, error: 'Reserved identifier: __gas is used internally by the VM gas metering system' };

        // Collect float warnings
        let warnings = this.checkFloatUsage(sourceCode);

        return { valid: true, warnings: warnings.length > 0 ? warnings : undefined };
    }

    // Detect float literal usage in contract source via AST walk
    // Returns array of warning strings
    checkFloatUsage(sourceCode) {
        let warnings = [];
        let parser = loadAcorn();
        let walker = loadAcornWalk();

        if (!parser || !walker) return warnings;

        let ast;
        try {
            ast = parser.parse(sourceCode, { ecmaVersion: 2020, sourceType: 'script', locations: true });
        } catch (e) {
            return warnings;
        }

        walker.simple(ast, {
            Literal(node) {
                if (typeof node.value === 'number' && String(node.value).includes('.')) {
                    let line = node.loc ? node.loc.start.line : '?';
                    warnings.push('Float literal (' + node.value + ') at line ' + line + ' — use xchain.math for deterministic arithmetic');
                }
            }
        });

        return warnings;
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
