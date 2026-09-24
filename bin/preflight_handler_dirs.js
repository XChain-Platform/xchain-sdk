#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * Directory handlers for the pre-flight drift gate (bin/check-preflight-drift.js).
 *
 * An indexer action handler used to be one file, src/actions/<name>.js, and every part of
 * the gate assumed it: a map row hashed one file, the fee walk read one file, and the
 * fee-quote literals were looked for in the loader alone. The indexer's file-size limit
 * splits the large handlers into src/actions/<name>/ with the entry at index.js and the
 * logic in named parts beside it. Hashing only index.js after such a split would keep the
 * row green while the validity logic moved into a part nobody hashes, which is the gate
 * grading one property and missing the one it exists to protect. So this module teaches
 * the gate the directory shape as a whole:
 *
 *   - a map row may name a DIRECTORY (`src/actions/<name>/`, trailing slash), hashed over
 *     every file in it, recursively, so editing, adding or removing any part moves the pin;
 *   - a FILE row also includes a same-named companion directory, since another valid split
 *     leaves `<name>.js` as the entry and moves its imported logic into `<name>/`;
 *   - the fee walk reads every source file owned by either split shape, not only its entry;
 *   - a fee-quote literal is found exactly once across the indexer's src/, so moving it
 *     out of the loader into a part neither loses it nor lets a second copy go unseen.
 *
 * Kept apart from the gate file so that file does not grow (it is already over the
 * 400-line limit), and runnable on its own to compute a pin:
 *
 *   node bin/preflight_handler_dirs.js <indexer root> src/actions/<name>/
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// | ... | `src/actions/x.js` | `<hash>` |   and, for a directory handler,
// | ... | `src/actions/x/`   | `<hash>` |
const ROW_RE = /\|\s*`(src\/actions\/[^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|/g;

// A flat row names a file directly under src/actions/. A path deeper than that is refused
// rather than hashed: pinning src/actions/<name>/index.js alone is exactly the row that
// lets the parts beside it escape, so it must be written as the directory row instead.
const FILE_ROW = /^src\/actions\/[\w-]+\.js$/;
const DIRECTORY_ROW = /^src\/actions\/[\w-]+\/$/;

// Source files the loader can require. A README or JSON part is still HASHED (it is in the
// directory), but only these can call createFeesObject, so only these are read by the walk.
const JS_SOURCE = /\.(?:c|m)?js$/;

function sha256(bytes) {
    return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Parse the map's table rows, each tagged with the kind of handler it names: 'file',
// 'directory' or 'malformed'.

// A malformed row is returned rather than dropped so the caller reports it: a row the
// parser skips silently is a handler nobody checks, while the table still reads complete.
function parseMapRows(text) {
    const rows = [];
    let m;
    ROW_RE.lastIndex = 0;
    while ((m = ROW_RE.exec(text)) !== null) {
        const handler = m[1];
        const kind = FILE_ROW.test(handler) ? 'file' : DIRECTORY_ROW.test(handler) ? 'directory' : 'malformed';
        rows.push({ handler, hash: m[2], kind });
    }
    return rows;
}

// Every file under a directory, recursively, as sorted POSIX paths relative to it. Sorted
// by UTF-8 bytes, the order `LC_ALL=C sort` gives, so a reviewer can recompute a pin with
// coreutils (the map shows the one-liner).

// Fails CLOSED on anything that makes the listing ambiguous or partial: the three throws
// below, and, unless the caller allows it, a directory with no files at all.
function listParts(dirAbs, { allowEmpty = false } = {}) {
    const names = [];
    const walk = (abs, rel) => {
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
            const childRel = rel ? `${rel}/${e.name}` : e.name;
            // The manifest is line-based, so a name carrying a newline makes it ambiguous.
            if (e.name.includes('\n')) throw new Error(`drift-gate: part name with a newline under ${dirAbs}: ${JSON.stringify(childRel)}`);
            // A link is refused either way it could go: followed, it hashes bytes from
            // outside the handler; skipped, it is a part the pin does not cover.
            if (e.isSymbolicLink()) throw new Error(`drift-gate: ${childRel} under ${dirAbs} is a symbolic link; a handler part must be a plain file.`);
            if (e.isDirectory()) walk(path.join(abs, e.name), childRel);
            else if (e.isFile()) names.push(childRel);
            else throw new Error(`drift-gate: ${childRel} under ${dirAbs} is not a plain file or directory.`);
        }
    };
    walk(dirAbs, '');
    if (!names.length && !allowEmpty) throw new Error(`drift-gate: ${dirAbs} holds no files, so there is nothing to hash.`);
    return names.sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
}

// The pin of a directory handler: the SHA-256 of a manifest with one line per part, in
// listParts order, `<sha256 of the part's bytes>  <relative name>\n`, which is byte-for-byte
// what `shasum -a 256` (or `sha256sum`) prints.

// It commits to the sorted list of (relative name, bytes): an edited part changes its line,
// an added or removed part changes the line set, and a renamed part changes its name.

// The per-part lines are returned too, so a drift report can show what the directory holds.
function hashDirectory(dirAbs) {
    const parts = listParts(dirAbs).map((name) => ({ name, sha256: sha256(fs.readFileSync(path.join(dirAbs, name))) }));
    const manifest = parts.map((p) => `${p.sha256}  ${p.name}\n`).join('');
    return { digest: sha256(manifest), parts };
}

// A flat entry may keep its original path while its implementation moves into a directory
// beside it. In that shape the row still names the entry, but its pin must commit to both
// the entry and every companion part. Names are relative to src/actions/ so the manifest
// distinguishes the entry from its tree and detects part renames as well as byte changes.
function hashFileWithCompanionParts(fileAbs) {
    const partsDir = fileAbs.replace(/\.js$/, '');
    let partsStat;
    try {
        partsStat = fs.lstatSync(partsDir);
    } catch (e) {
        if (e && e.code === 'ENOENT') return { digest: sha256(fs.readFileSync(fileAbs)) };
        throw e;
    }
    if (partsStat.isSymbolicLink()) {
        throw new Error(`drift-gate: companion ${partsDir} is a symbolic link; handler parts must be in a plain directory.`);
    }
    if (!partsStat.isDirectory()) return { digest: sha256(fs.readFileSync(fileAbs)) };

    const entryName = path.basename(fileAbs);
    const partsName = path.basename(partsDir);
    const parts = [{ name: entryName, sha256: sha256(fs.readFileSync(fileAbs)) }];
    for (const name of listParts(partsDir)) {
        parts.push({ name: `${partsName}/${name}`, sha256: sha256(fs.readFileSync(path.join(partsDir, name))) });
    }
    parts.sort((a, b) => Buffer.compare(Buffer.from(a.name, 'utf8'), Buffer.from(b.name, 'utf8')));
    const manifest = parts.map((p) => `${p.sha256}  ${p.name}\n`).join('');
    return { digest: sha256(manifest), parts };
}

function isDirectory(abs) {
    try { return fs.lstatSync(abs).isDirectory(); } catch (e) { return false; }
}

// Hash one mapped row against the checkout. Returns { actual, parts? } or { problem }.

// A flat row with no companion directory is hashed as the file's bytes, preserving legacy
// pins. When a companion directory exists, the entry and its parts form one manifest and
// the row needs the deliberate re-pin that closes the old blind spot.

// The problems a directory split introduces are named one by one below rather than folded
// into a hash mismatch, because each has its own fix.
function hashMappedRow(indexerRoot, row) {
    const abs = path.join(indexerRoot, row.handler);
    // A malformed row names neither shape, so nothing is hashed for it.
    if (row.kind === 'malformed') {
        return { problem: `${row.handler}: not a mappable handler path; a row names src/actions/<name>.js or the directory src/actions/<name>/` };
    }
    if (row.kind === 'file') {
        if (fs.existsSync(abs)) {
            try {
                const { digest, parts } = hashFileWithCompanionParts(abs);
                return { actual: digest, parts };
            } catch (e) {
                return { problem: `${row.handler}: ${e && e.message ? e.message : String(e)}` };
            }
        }
        // A flat row whose handler became a directory: the fix is a re-pin as a directory row.
        const dir = abs.replace(/\.js$/, '');
        if (isDirectory(dir)) {
            return { problem: `${row.handler}: now a directory handler; review it and re-pin the row as ${row.handler.replace(/\.js$/, '/')}` };
        }
        return { problem: row.handler };
    }
    const flat = abs.replace(/\/$/, '') + '.js';
    if (!isDirectory(abs)) {
        return { problem: fs.existsSync(flat) ? `${row.handler}: not a directory (a flat ${row.handler.replace(/\/$/, '.js')} exists instead)` : row.handler };
    }
    // require('./<name>') resolves a flat <name>.js ahead of <name>/index.js, so with both
    // present the directory this would hash is not the code that runs.
    if (fs.existsSync(flat)) {
        return { problem: `${row.handler}: a flat ${row.handler.replace(/\/$/, '.js')} beside it is what require() resolves first; map that entry file so its pin includes this companion parts directory` };
    }
    try {
        const { digest, parts } = hashDirectory(abs);
        return { actual: digest, parts };
    } catch (e) {
        return { problem: `${row.handler}: ${e && e.message ? e.message : String(e)}` };
    }
}

/* Compare every mapped row. `missing` holds a line per row that could not be hashed as
 * mapped; `drift` holds each row whose hash moved, with the parts it holds now. */
function compareRows(indexerRoot, rows) {
    const missing = [];
    const drift = [];
    for (const row of rows) {
        const r = hashMappedRow(indexerRoot, row);
        if (r.problem) { missing.push(r.problem); continue; }
        if (r.actual !== row.hash) drift.push({ handler: row.handler, expected: row.hash, actual: r.actual, parts: r.parts });
    }
    return { missing, drift };
}

function formatDrift(d) {
    const head = `  ${d.handler}\n    was ${d.expected}\n    now ${d.actual}`;
    if (!d.parts) return head;
    return head + '\n    parts hashed now (sha256  name):\n' + d.parts.map((p) => `      ${p.sha256}  ${p.name}`).join('\n');
}

function stripCommentsAndStrings(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
}

// The handlers the fee walk reads, each with every source file that belongs to it. A
// handler is src/actions/<name>.js, optionally with parts in src/actions/<name>/, or a
// directory handler whose entry is src/actions/<name>/index.js.

// A flat readdir of *.js alone silently drops every directory handler, and a dropped
// handler reads as "charges no fee" rather than as a broken walk, so both shapes are
// resolved here.

// src/actions/index.js is the ACTION LOADER, not a handler, and is skipped so it cannot
// enrol itself as action INDEX.

// A directory handler is read WHOLE: a split handler's createFeesObject call can sit in
// any part (fees.js by the split convention), and reading index.js alone drops it exactly
// as a flat readdir drops a directory.
function feeWalkHandlers(actionsDir, entries) {
    const handlers = [];
    const flatNames = new Set(entries
        .filter((e) => e.isFile() && e.name.endsWith('.js') && e.name !== 'index.js')
        .map((e) => path.basename(e.name, '.js')));
    for (const e of entries) {
        if (e.isDirectory()) {
            const dirAbs = path.join(actionsDir, e.name);
            const files = listParts(dirAbs, { allowEmpty: true }).filter((n) => JS_SOURCE.test(n)).map((n) => path.join(dirAbs, n));
            // A same-named flat entry owns this parts tree. It is added with the entry in
            // the file branch below, including any index.js the tree happens to contain.
            if (flatNames.has(e.name)) {
                continue;
            } else if (fs.existsSync(path.join(dirAbs, 'index.js'))) {
                handlers.push({ action: e.name, files });
            // A directory with no index.js is not a handler, but if one of its files charges
            // a fee the walk cannot say for which action, so that fails CLOSED here rather
            // than being skipped.
            } else if (files.some(callsCreateFeesObject)) {
                throw new Error(`drift-gate: src/actions/${e.name}/ has no index.js, so it is not a handler, yet a file in it `
                    + 'calls createFeesObject. The fee walk cannot name the action that charges; fix the layout or the walk.');
            }
        } else if (e.isFile() && e.name.endsWith('.js') && e.name !== 'index.js') {
            const action = path.basename(e.name, '.js');
            const entry = path.join(actionsDir, e.name);
            const partsDir = path.join(actionsDir, action);
            const files = [entry];
            let partsStat;
            try { partsStat = fs.lstatSync(partsDir); } catch (err) {
                if (!err || err.code !== 'ENOENT') throw err;
            }
            if (partsStat && partsStat.isSymbolicLink()) {
                throw new Error(`drift-gate: companion src/actions/${action}/ is a symbolic link; handler parts must be in a plain directory.`);
            }
            if (partsStat && partsStat.isDirectory()) {
                files.push(...listParts(partsDir, { allowEmpty: true })
                    .filter((n) => JS_SOURCE.test(n))
                    .map((n) => path.join(partsDir, n)));
            }
            handlers.push({ action, files });
        }
    }
    return handlers;
}

function callsCreateFeesObject(file) {
    return /\bcreateFeesObject\s*\(/.test(stripCommentsAndStrings(fs.readFileSync(file, 'utf8')));
}

// `const NAME = [...]`, `Object.freeze([...])` or `new Set([...])`, capturing the body.
// The one pattern both the per-file parsers in the gate and the cross-file count below use,
// so "found exactly once" and "parsed" can never disagree about what a declaration is.
function declarationPattern(name) {
    return new RegExp('const\\s+' + name + '\\s*=\\s*(?:new Set\\(|Object\\.freeze\\()?\\s*\\[([^\\]]*)\\]', 'g');
}

function indexerSourceFiles(indexerRoot) {
    const src = path.join(indexerRoot, 'src');
    const out = [];
    const walk = (abs, rel) => {
        for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
            if (e.name === 'node_modules') continue;
            const childRel = `${rel}/${e.name}`;
            if (e.isDirectory()) walk(path.join(abs, e.name), childRel);
            else if (e.isFile() && JS_SOURCE.test(e.name)) out.push(childRel);
        }
    };
    walk(src, 'src');
    return out.sort();
}

// A reader for a literal the indexer declares once, wherever under src/ it lives. A split
// moves code out of src/actions/index.js, and a fee-quote literal can move with it.

// Binding the read to the loader's path reports "found 0" against a correct tree, and a
// stale second copy left behind by such a move is the one read. So the declaration is
// counted across every source file under src/ and must occur exactly once in total.

// The file holding it is parsed with the gate's own parser. Symbolic links are not
// followed, so a linked copy counts neither twice nor loops the walk.

// Returns `(name) => parse(text, name, where)`. The file listing and contents are read once
// per reader, since the seam asks for several names in a row.
function indexerLiteralReader(indexerRoot, parse) {
    const files = indexerSourceFiles(indexerRoot).map((rel) => ({ rel, text: fs.readFileSync(path.join(indexerRoot, rel), 'utf8') }));
    return (name) => {
        const hits = files
            .map((f) => ({ ...f, count: (f.text.match(declarationPattern(name)) || []).length }))
            .filter((f) => f.count > 0);
        const total = hits.reduce((n, f) => n + f.count, 0);
        if (total !== 1) {
            throw new Error(`drift-gate: expected exactly one ${name} declaration under xchain-indexer/src/, found ${total}`
                + (hits.length ? ` (${hits.map((f) => `${f.rel} x${f.count}`).join(', ')})` : '')
                + '. That literal is what this gate compares; find where it moved before editing this check.');
        }
        return parse(hits[0].text, name, `xchain-indexer/${hits[0].rel}`);
    };
}

/* Print the pin line for one handler: the value a re-pin writes into the map's table. */
function main(argv) {
    const [indexerRoot, handler] = argv;
    if (!indexerRoot || !handler) {
        console.error('usage: node bin/preflight_handler_dirs.js <indexer root> <src/actions/<name>.js | src/actions/<name>/>');
        return 2;
    }
    const [row] = parseMapRows(`| \`${handler}\` | \`${'0'.repeat(64)}\` |`);
    const r = row ? hashMappedRow(indexerRoot, row) : { problem: `${handler}: not a src/actions/ handler path` };
    if (r.problem) {
        console.error(`drift-gate: ${r.problem}`);
        return 1;
    }
    console.log(`\`${handler}\` \`${r.actual}\``);
    for (const p of r.parts || []) console.log(`  ${p.sha256}  ${p.name}`);
    return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = {
    parseMapRows, listParts, hashDirectory, hashFileWithCompanionParts, hashMappedRow, compareRows, formatDrift,
    stripCommentsAndStrings, feeWalkHandlers, declarationPattern, indexerLiteralReader, main,
};
