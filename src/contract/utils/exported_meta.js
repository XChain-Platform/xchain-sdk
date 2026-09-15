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

const {
    loadAcorn,
    loadAcornWalk,
    META_VERDICTS,
    META_NAME_MAX_BYTES,
    META_DESCRIPTION_MAX_BYTES,
    META_VERSION_MAX_BYTES,
    isValidMetaText,
    readMetaLiterals,
} = require('./meta_literals.js');

function readExportAssignments(ast, walker) {
    let exportObj  = null;   // module.exports = { ... }
    let exportName = null;   // module.exports = someIdentifier
    let seenExport = false;
    let exportAssignments = 0;         // every module.exports assignment, any scope
    let metaAssignments = new Map();   // identifier -> node assigned to <id>.meta
    let metaAssignmentCounts = new Map();

    walker.simple(ast, {
        AssignmentExpression(node) {
            let l = node.left;
            if (!l || l.type !== 'MemberExpression' || l.computed) return;
            if (!l.object || l.object.type !== 'Identifier' || !l.property) return;
            if (l.object.name === 'module' && l.property.name === 'exports') {
                // First module.exports assignment wins; the count below decides
                // whether that read may be trusted at all.
                exportAssignments += 1;
                if (seenExport) return;
                seenExport = true;
                if (node.right && node.right.type === 'ObjectExpression') exportObj = node.right;
                else if (node.right && node.right.type === 'Identifier') exportName = node.right.name;
                return;
            }
            // The function-export form (spec R1): `contract.meta = { ... }`, which the
            // VM reads off a function export too.
            if (l.property.name === 'meta') {
                metaAssignmentCounts.set(l.object.name, (metaAssignmentCounts.get(l.object.name) || 0) + 1);
                if (!metaAssignments.has(l.object.name)) metaAssignments.set(l.object.name, node.right);
            }
        }
    });

    return { exportObj, exportName, exportAssignments, metaAssignments, metaAssignmentCounts };
}

module.exports = {
    // The contract's exported callable method names (the `module.exports = { fn... }`
    // surface). Acorn-only (no V8 / isolate); returns [] on unparseable source or
    // when acorn is unavailable. SDK-local on purpose: this powers a client-side
    // deploy nudge (a contract exporting `initialize` with no CONSTRUCTOR_PARAMS),
    // so it must NOT edit the byte-identity-locked consensus lint_core. Mirrors that
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
    },

    // Static read of a contract's exported `meta` (contract identity: name,
    // description, version). Same acorn walk shape as getExportedMethodNames
    // (ES2020, script), and the same SDK-local rule: never lint_core.
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

        let { exportObj, exportName, exportAssignments, metaAssignments, metaAssignmentCounts } =
            readExportAssignments(ast, walker);

        // More than one export assignment: the isolate evaluates whichever runs LAST,
        // and a source-order walk cannot say which that is (an assignment may sit in a
        // function, a branch or a loop). `error` here is the exact consensus refusal
        // string, so a first-wins guess can refuse a deploy the chain would accept.
        // Say undecidable and advise instead; the VM toolkit gate carries the twin.
        if (exportAssignments > 1) return { status: 'undecidable' };

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
            // Same reasoning one level down: two `<id>.meta` assignments leave the
            // first read unprovable, so it advises rather than refusing.
            if ((metaAssignmentCounts.get(exportName) || 0) > 1) return { status: 'undecidable' };
            let right = metaAssignments.get(exportName);
            if (!right || right.type !== 'ObjectExpression') return { status: 'undecidable' };
            return readMetaLiterals(right);
        }

        return { status: 'undecidable' };
    },

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
    },
};
