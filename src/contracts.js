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
 * XChain Platform SDK - Contract Utilities
 *
 * Authoring helpers for VM smart contracts: base64 encoding, syntax
 * validation, float detection, code size checks, gas estimation.
 *
 * These are pure functions with no dependency on isolated-vm.
 *
 * validate() / checkFloatUsage() delegate to ./contract/lint-core.js, a
 * BYTE-IDENTICAL vendored copy of xchain-vm/src/lint-core.js, so the SDK's
 * pre-flight verdict matches the indexer's deploy-time validation exactly
 * (no false greens). A CI parity guard (sha256) fails the build on drift.
 * lint-core pulls acorn/acorn-walk/astring (pure JS, browser-safe; now hard
 * deps), never isolated-vm.
 *
 ********************************************************************/

const { SDKContractError } = require('./errors.js');
const { lintSource, findFloatWarnings } = require('./contract/lint-core.js');
const abiCore = require('./contract/abi-core.js');

// 64KB contract source code limit. Canonical value in
// xchain-documentation/protocol/constants.js (MAX_CODE_SIZE), also enforced by
// the indexer (DEPLOY) and the VM isolate limit. Imported from validator.js
// (the parity-guarded SDK copy) so the two SDK entry points cannot diverge.
const { MAX_CODE_SIZE } = require('./validator.js');

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


/* --- Contract identity (`meta`) -------------------------------------------
 *
 * CONTRACT_META_REQUIRED makes `meta.name` and `meta.description` a consensus
 * requirement: at/after the flag day the indexer rejects a DEPLOY whose contract
 * exports no conforming `meta`. The SDK sees that BEFORE the caller pays a fee.
 *
 * SDK-LOCAL on purpose: this is a client-side mirror, never lint-core (the frozen
 * byte-vendored consensus set) and never an import of the xchain-vm toolkit (which
 * is not an SDK dependency and pulls isolated-vm). The toolkit carries its own copy
 * of the same algorithm; the two are kept in step by the spec, not by a require.
 *
 * The read is STATIC (acorn) while the chain EVALUATES `meta` in the isolate, so a
 * computed value is invisible here. That asymmetry decides what may refuse: only a
 * missing key or a failing string LITERAL blocks; anything the walk cannot see
 * advises, so the SDK never refuses a contract the chain would accept.
 */

// Frozen consensus tokens, verbatim from spec 2.3 (the same strings the indexer
// writes into the action's status), so the caller reads the chain's own words.
const META_VERDICTS = {
    REQUIRED:    'invalid: CONTRACT_MANIFEST (meta required)',
    NAME:        'invalid: CONTRACT_MANIFEST (meta.name must be a string of 1..64 bytes, printable, trimmed)',
    DESCRIPTION: 'invalid: CONTRACT_MANIFEST (meta.description must be a string of 1..512 bytes, printable, trimmed)',
    VERSION:     'invalid: CONTRACT_MANIFEST (meta.version must be a string of 1..32 bytes, printable, trimmed)'
};

const META_NAME_MAX_BYTES        = 64;
const META_DESCRIPTION_MAX_BYTES = 512;
const META_VERSION_MAX_BYTES     = 32;

// Code points banned ANYWHERE in a meta text field: C0 controls, DEL + C1,
// zero-width joiners/spaces, and the bidi overrides that let a name render as
// something other than its bytes. U+000A is banned too, excepted only for
// `description` (allowLf). Exactly the consensus set, never a superset: widening
// it client-side would refuse a contract the chain accepts.
function isBannedMetaCodePoint(cp, allowLf) {
    if (cp === 0x0A) return !allowLf;
    if (cp <= 0x1F) return true;                     // C0 controls
    if (cp >= 0x7F && cp <= 0x9F) return true;       // DEL + C1 controls
    if (cp >= 0x200B && cp <= 0x200D) return true;   // zero-width space/non-joiner/joiner
    if (cp === 0x2060 || cp === 0xFEFF) return true; // word joiner, BOM/ZWNBSP
    if (cp >= 0x202A && cp <= 0x202E) return true;   // bidi embedding/override
    if (cp >= 0x2066 && cp <= 0x2069) return true;   // bidi isolates
    if (cp === 0x200E || cp === 0x200F) return true; // LRM / RLM
    return false;
}

// "Trimmed" as an explicit code-point set rather than String.trim(), which follows
// the host Node's Unicode table and would make the client verdict disagree with the
// chain's on a different Node build.
const META_EDGE_CODE_POINTS = new Set([
    0x0020, 0x00A0, 0x1680,
    0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200A,
    0x2028, 0x2029, 0x202F, 0x205F, 0x3000
]);

function isMetaEdgeCodePoint(cp, allowLf) {
    return META_EDGE_CODE_POINTS.has(cp) || (allowLf && cp === 0x0A);
}

// The consensus text grammar for one meta field (spec 2.3), mirrored client-side:
// UTF-8 BYTES, no locale, no trim(), no normalisation.
// allowLf: LF is legal inside (and at the edges of) a description only.
function isValidMetaText(s, maxBytes, allowLf) {
    if (typeof s !== 'string') return false;
    // A lone surrogate re-encodes as U+FFFD for the byte count and is refused by a
    // utf8mb4 column, so it can never be stored as written.
    if (typeof s.isWellFormed === 'function' && !s.isWellFormed()) return false;
    let bytes = Buffer.byteLength(s, 'utf8');
    if (bytes < 1 || bytes > maxBytes) return false;
    let cps = Array.from(s);
    for (let ch of cps) {
        if (isBannedMetaCodePoint(ch.codePointAt(0), allowLf)) return false;
    }
    if (isMetaEdgeCodePoint(cps[0].codePointAt(0), allowLf)) return false;
    if (isMetaEdgeCodePoint(cps[cps.length - 1].codePointAt(0), allowLf)) return false;
    return true;
}

// Read the literal name/description/version out of a `meta` object literal.
//
// Three outcomes per key, and the difference is what decides refusing vs advising:
//   - a string LITERAL: the value is known, so the grammar judges it;
//   - a NON-LITERAL expression ('Escrow ' + x, an identifier, a call, a template
//     literal): computed meta. The chain evaluates `meta` in the isolate and judges
//     whatever it yields, so a static read that cannot see the value must not refuse
//     it; the key is reported in `computed` and only advised on;
//   - a literal that is not a string (version: 1, name: null): the chain rejects it,
//     and so do we, through the ordinary null read (reported in nonStringLiteral so
//     an optional key can tell "absent" from "present and wrong").
// A key that is simply MISSING also reads null, which is what refuses a nameless
// contract.
function readMetaLiterals(metaObj) {
    for (let p of metaObj.properties) {
        // A spread or a computed key can inject or rename any of the three fields.
        if (p.type !== 'Property' || p.computed) return { status: 'undecidable' };
    }
    let out = {
        status: 'present',
        name: null,
        description: null,
        version: null,
        computed: [],           // keys present whose value is a non-literal expression
        nonStringLiteral: [],   // keys present whose value is a literal but not a string
        line: (metaObj.loc && metaObj.loc.start && metaObj.loc.start.line) || null
    };
    for (let p of metaObj.properties) {
        let key = p.key && (p.key.name || p.key.value);
        if (key !== 'name' && key !== 'description' && key !== 'version') continue;
        let v = p.value;
        if (v && v.type === 'Literal' && typeof v.value === 'string') out[key] = v.value;
        else if (v && v.type === 'Literal') out.nonStringLiteral.push(key);
        else out.computed.push(key);
    }
    return out;
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
    // valid result here means the contract clears the indexer's syntax gate too,
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

    // The contract's exported callable method names (the `module.exports = { fn... }`
    // surface). Acorn-only (no V8 / isolate); returns [] on unparseable source or
    // when acorn is unavailable. SDK-local on purpose: this powers a client-side
    // deploy nudge (a contract exporting `initialize` with no CONSTRUCTOR_PARAMS),
    // so it must NOT edit the byte-identity-locked consensus lint-core. Mirrors that
    // primitive's findExportsObject logic (same ES2020 pin) so the view matches.
    getExportedMethodNames(sourceCode) {
        let parser = loadAcorn();
        let walker = loadAcornWalk();
        if (!parser || !walker) return [];
        let ast;
        try {
            ast = parser.parse(String(sourceCode), { ecmaVersion: 2020, sourceType: 'script', locations: false });
        } catch (e) {
            return [];
        }
        let obj = null;
        walker.simple(ast, {
            AssignmentExpression(node) {
                if (obj) return;
                let l = node.left;
                if (l && l.type === 'MemberExpression' && !l.computed
                    && l.object && l.object.type === 'Identifier' && l.object.name === 'module'
                    && l.property && l.property.name === 'exports'
                    && node.right && node.right.type === 'ObjectExpression')
                    obj = node.right;
            }
        });
        let names = [];
        if (obj) {
            for (let p of obj.properties) {
                if (p.type !== 'Property' || p.computed) continue;
                let key = p.key && (p.key.name || p.key.value);
                let v = p.value;
                if (key && v && (v.type === 'FunctionExpression' || v.type === 'ArrowFunctionExpression'))
                    names.push(String(key));
            }
        }
        return names;
    }

    // Static read of a contract's exported `meta` (contract identity: name,
    // description, version). Same acorn walk shape as getExportedMethodNames
    // (ES2020, script), and the same SDK-local rule: never lint-core.
    //
    // Returns exactly one of:
    //   { status: 'present', name, description, version, computed[], nonStringLiteral[], line }
    //        a `meta` object literal was found; each field is its string literal, or
    //        null when the key is absent or its value is not a string literal.
    //        `computed` names the keys whose value is a non-literal expression (the
    //        chain evaluates those, so they advise rather than refuse);
    //        `nonStringLiteral` names keys whose literal value is not a string.
    //   { status: 'absent' }
    //        a literal export shape was found and it carries no `meta`: this is the
    //        one outcome that proves the chain will answer "meta required".
    //   { status: 'undecidable' }
    //        acorn is unavailable, the source does not parse, no literal export shape
    //        was found (module.exports = function(){}, an exports.foo surface, a
    //        factory), `meta` is not an object literal, or the object uses a spread
    //        or a computed key. The chain evaluates it at deploy; the SDK does not guess.
    // Never throws.
    getExportedMeta(sourceCode) {
        let parser = loadAcorn();
        let walker = loadAcornWalk();
        if (!parser || !walker) return { status: 'undecidable' };
        let ast;
        try {
            ast = parser.parse(String(sourceCode), { ecmaVersion: 2020, sourceType: 'script', locations: true });
        } catch (e) {
            return { status: 'undecidable' };
        }

        let exportObj  = null;   // module.exports = { ... }
        let exportName = null;   // module.exports = someIdentifier
        let seenExport = false;
        let metaAssignments = new Map();   // identifier -> node assigned to <id>.meta

        walker.simple(ast, {
            AssignmentExpression(node) {
                let l = node.left;
                if (!l || l.type !== 'MemberExpression' || l.computed) return;
                if (!l.object || l.object.type !== 'Identifier' || !l.property) return;
                if (l.object.name === 'module' && l.property.name === 'exports') {
                    // First module.exports assignment wins, matching the method-names walk.
                    if (seenExport) return;
                    seenExport = true;
                    if (node.right && node.right.type === 'ObjectExpression') exportObj = node.right;
                    else if (node.right && node.right.type === 'Identifier') exportName = node.right.name;
                    return;
                }
                // The function-export form (spec R1): `contract.meta = { ... }`, which the
                // VM reads off a function export too.
                if (l.property.name === 'meta' && !metaAssignments.has(l.object.name))
                    metaAssignments.set(l.object.name, node.right);
            }
        });

        if (exportObj) {
            for (let p of exportObj.properties) {
                if (p.type !== 'Property' || p.computed) return { status: 'undecidable' };
            }
            let metaProp = exportObj.properties.find((p) => (p.key && (p.key.name || p.key.value)) === 'meta');
            if (!metaProp) return { status: 'absent' };
            if (!metaProp.value || metaProp.value.type !== 'ObjectExpression') return { status: 'undecidable' };
            return readMetaLiterals(metaProp.value);
        }

        if (exportName) {
            if (!metaAssignments.has(exportName)) return { status: 'absent' };
            let right = metaAssignments.get(exportName);
            if (!right || right.type !== 'ObjectExpression') return { status: 'undecidable' };
            return readMetaLiterals(right);
        }

        return { status: 'undecidable' };
    }

    // Pre-flight verdict for contract identity, shared by every SDK deploy seam
    // (sdk.deploy's lint, walletSession.deploy/deployChunk's preflight).
    // Returns { error: string|null, advisories: string[] }: `error` is the exact
    // consensus string the chain would write, and is non-null ONLY for a shape the
    // static read PROVES wrong (no meta at all, or a failing string literal).
    // Everything the walk cannot see becomes an advisory, so the SDK never refuses a
    // deploy the chain would accept. Never throws.
    checkExportedMeta(sourceCode) {
        let read = this.getExportedMeta(sourceCode);
        let advisories = [];

        if (read.status === 'undecidable') {
            return {
                error: null,
                advisories: ['contract identity (meta) could not be read statically; the chain evaluates ' +
                    'meta at deploy, and CONTRACT_META_REQUIRED rejects a contract whose evaluated meta ' +
                    'has no valid name and description']
            };
        }

        if (read.status === 'absent') {
            return {
                error: META_VERDICTS.REQUIRED,
                advisories: []
            };
        }

        let computed = read.computed || [];
        if (computed.length) {
            advisories.push('contract identity: meta.' + computed.join(', meta.') +
                (computed.length > 1 ? ' are ' : ' is ') +
                'a computed expression, so the SDK cannot check it here; the chain evaluates meta at ' +
                'deploy and CONTRACT_META_REQUIRED judges the evaluated value (string literals are ' +
                'recommended, so what you read is what the chain records)');
        }

        // Rows 5-7 of spec 2.3, in order: first failure wins, so the caller sees the
        // same string the chain would write.
        if (!computed.includes('name') && !isValidMetaText(read.name, META_NAME_MAX_BYTES, false))
            return { error: META_VERDICTS.NAME, advisories };
        if (!computed.includes('description') && !isValidMetaText(read.description, META_DESCRIPTION_MAX_BYTES, true))
            return { error: META_VERDICTS.DESCRIPTION, advisories };
        // `version` is optional: judged only when the key is present with a literal
        // value (a string that fails the grammar, or a literal that is not a string).
        let versionLiteralPresent = read.version !== null || (read.nonStringLiteral || []).includes('version');
        if (!computed.includes('version') && versionLiteralPresent
            && !isValidMetaText(read.version, META_VERSION_MAX_BYTES, false))
            return { error: META_VERDICTS.VERSION, advisories };

        return { error: null, advisories };
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

    // Count C-style `for (init; test; update)` statements: the loops the VM
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
                // Unparseable source; fall through to the regex approximation.
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
        // body AND the update expression. `for (...; i++)` is metered as
        // `for (...; (__gas(1), i++))`, so each iteration is charged twice. Loops
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

    // Extract the optional self-declared `abi` metadata block from contract
    // source (spec: xchain-documentation/protocol/Contract_ABI.md). Fail-closed:
    // a dynamic or structurally wrong abi/version/methods returns null, while a
    // malformed SINGLE method entry drops only that method. The abi is display
    // metadata only, never validated against the code and never consensus.
    //
    // Delegates to the vendored ./contract/abi-core.js (canonical copy:
    // xchain-explorer/src/abi-core.js; byte-identity enforced by the
    // abi-core-drift unit test and the root bin/ci-all.sh guard).
    // Returns { version, methods } | null. Never throws.
    parseAbi(sourceCode) {
        return abiCore.parseAbi(sourceCode);
    }

}

module.exports = ContractUtils;

// Re-export so parity/drift guards can assert this entry point rides the same
// (validator-sourced) cap; see test/unit/protocolSizeCaps.test.js.
module.exports.MAX_CODE_SIZE = MAX_CODE_SIZE;

// The frozen CONTRACT_MANIFEST meta strings and the client-side grammar, exported
// so a caller (and the deploy seams in XChainSDK / walletSession) can compare
// against the exact consensus token instead of re-typing it.
module.exports.META_VERDICTS             = META_VERDICTS;
module.exports.META_NAME_MAX_BYTES       = META_NAME_MAX_BYTES;
module.exports.META_DESCRIPTION_MAX_BYTES = META_DESCRIPTION_MAX_BYTES;
module.exports.META_VERSION_MAX_BYTES    = META_VERSION_MAX_BYTES;
module.exports.isValidMetaText           = isValidMetaText;
