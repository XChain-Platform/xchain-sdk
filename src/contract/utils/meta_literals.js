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
 * validate() / checkFloatUsage() delegate to ./contract/lint_core.js, a
 * BYTE-IDENTICAL vendored copy of xchain-vm/src/lint_core.js, so the SDK's
 * pre-flight verdict matches the indexer's deploy-time validation exactly
 * (no false greens). A CI parity guard (sha256) fails the build on drift.
 * lint_core pulls acorn/acorn-walk/astring (pure JS, browser-safe hard deps),
 * never isolated-vm.
 *
 ********************************************************************/

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
 * SDK-LOCAL on purpose: this is a client-side mirror, never lint_core (the frozen
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

module.exports = {
    loadAcorn,
    loadAcornWalk,
    META_VERDICTS,
    META_NAME_MAX_BYTES,
    META_DESCRIPTION_MAX_BYTES,
    META_VERSION_MAX_BYTES,
    isValidMetaText,
    readMetaLiterals,
};
