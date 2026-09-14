'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Handler DIRECTORIES in the pre-flight drift gate (§8.5).
//
// A mapped handler used to be one file, and the gate assumed it everywhere: a row hashed
// one file, the fee walk read one file, and the fee-quote literals were looked for in the
// loader alone. The indexer's file-size limit splits the large handlers into
// src/actions/<name>/ with an index.js entry and the logic in parts beside it. Hashing
// index.js alone would keep a row green while the validity logic moved into a part nobody
// hashes, which is the gate grading one property and missing the one it protects.
//
// So what is asserted here is coverage, not shape: every part is inside the digest, an
// added or removed part moves it, a fee call in any part enrols the action, and a literal
// that moved out of the loader is still found exactly once. The failure directions are
// driven too, because a directory split has failure modes a flat file never had (a flat
// <name>.js left beside the directory still wins require(), and a row that names a file
// INSIDE a handler directory pins one part while the rest escape).
//
// Fixtures are synthetic: the live sibling checkout is a moving target, and this suite
// holds the same hermetic contract as the rest of the drift-gate unit tests.

const { expect } = require('chai');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dirs = require('../../../bin/preflight_handler_dirs.js');
const gate = require('../../../bin/check-preflight-drift.js');

const SDK_ROOT = path.join(__dirname, '..', '..', '..');
const REAL_MAP = path.join(SDK_ROOT, 'src', 'preflight', 'INDEXER-MAP.md');
const ZERO = '0'.repeat(64);
// sha256('abc'), the value every reference implementation prints, so the flat-row leg is
// pinned to an outside answer rather than to the gate's own hashing.
const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
// sha256 of the manifest of { index.js: 'abc', lib/x.js: '' }, taken from coreutils:
//   find . -type f | sed 's|^\./||' | LC_ALL=C sort | xargs shasum -a 256 | shasum -a 256
const DIGEST_ABC_EMPTY = '2f49d30a8e31cecab46ffda54c4a4df8fb79fad1eeb117577793188b337018ee';

const ROOTS = [];

function tempRoot() {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-handler-dirs-'));
    ROOTS.push(r);
    return r;
}

function cleanRoots() {
    while (ROOTS.length) fs.rmSync(ROOTS.pop(), { recursive: true, force: true });
}

function put(root, rel, text) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return abs;
}

function row(handler, hash) {
    return dirs.parseMapRows(`| \`checks/x.js\` | \`${handler}\` | \`${hash || ZERO}\` |`)[0];
}

function pinOf(root, handler) {
    return dirs.hashMappedRow(root, row(handler)).actual;
}

/* A handler split the way the indexer's split convention splits one: the entry at
 * index.js, named parts beside it, and one part a directory deeper. */
function splitHandler(root, name) {
    put(root, `src/actions/${name}/index.js`, "const validate = require('./validate.js');\nmodule.exports = { validate };\n");
    put(root, `src/actions/${name}/validate.js`, 'module.exports = function validate(d) { return d.quantity > 0; };\n');
    put(root, `src/actions/${name}/fees.js`, 'module.exports = async function fees(u, d, p) { return u.createFeesObject(d, p); };\n');
    put(root, `src/actions/${name}/limits/caps.js`, 'module.exports = { MAX_PARTS: 10 };\n');
    return path.join(root, 'src', 'actions', name);
}

describe('drift map rows: what a row may name (§8.5)', function () {
    afterEach(cleanRoots);

    it('anchors the flat-row known answer outside the gate', function () {
        // sha256('abc') from Node's own crypto, so the leg below compares the gate against
        // a reference value rather than against its own hashing.
        expect(crypto.createHash('sha256').update('abc').digest('hex')).to.equal(SHA256_ABC);
    });

    it('reads every shipped row as a file or a directory handler, none malformed', function () {
        const rows = gate.parseMap(REAL_MAP);
        expect(rows.length, 'map has mapping rows').to.be.greaterThan(0);
        for (const r of rows) expect(r.kind, r.handler).to.be.oneOf(['file', 'directory']);
    });

    it('still hashes a flat handler as the bytes of that one file', function () {
        // The pin every existing row carries: unchanged by directory support, which is what
        // lets the shipped map stay green with no re-pin.
        const root = tempRoot();
        put(root, 'src/actions/send.js', 'abc');
        expect(row('src/actions/send.js').kind).to.equal('file');
        expect(pinOf(root, 'src/actions/send.js')).to.equal(SHA256_ABC);
        expect(dirs.compareRows(root, [row('src/actions/send.js', SHA256_ABC)]))
            .to.deep.equal({ missing: [], drift: [] });
    });

    it('refuses a row that names one file INSIDE a handler directory', function () {
        // The row that would pin index.js and let every part beside it escape the hash.
        const root = tempRoot();
        splitHandler(root, 'batch');
        const r = row('src/actions/batch/index.js');
        expect(r.kind).to.equal('malformed');
        const { missing, drift } = dirs.compareRows(root, [r]);
        expect(drift, 'a malformed row is never hashed').to.deep.equal([]);
        expect(missing).to.have.lengthOf(1);
        expect(missing[0]).to.include('not a mappable handler path');
    });
});

describe('drift map rows: a directory handler is hashed whole', function () {
    afterEach(cleanRoots);

    it('pins the sorted (name, bytes) manifest, reproducibly', function () {
        const root = tempRoot();
        put(root, 'src/actions/batch/index.js', 'abc');
        put(root, 'src/actions/batch/lib/x.js', '');
        const { digest, parts } = dirs.hashDirectory(path.join(root, 'src', 'actions', 'batch'));
        expect(parts.map((p) => p.name), 'sorted, POSIX, relative').to.deep.equal(['index.js', 'lib/x.js']);
        expect(parts[0].sha256).to.equal(SHA256_ABC);
        expect(digest).to.equal(DIGEST_ABC_EMPTY);
        expect(pinOf(root, 'src/actions/batch/')).to.equal(DIGEST_ABC_EMPTY);
    });

    it('covers EVERY part: editing any one of them moves the pin', function () {
        // The whole point of the row: no part may be editable without the pin noticing.
        const root = tempRoot();
        const dir = splitHandler(root, 'batch');
        const pinned = pinOf(root, 'src/actions/batch/');
        for (const part of dirs.listParts(dir)) {
            const abs = path.join(dir, part);
            const original = fs.readFileSync(abs);
            fs.writeFileSync(abs, Buffer.concat([original, Buffer.from('// edited\n')]));
            expect(pinOf(root, 'src/actions/batch/'), `editing ${part} must move the pin`).to.not.equal(pinned);
            fs.writeFileSync(abs, original);
            expect(pinOf(root, 'src/actions/batch/'), `restoring ${part} must restore the pin`).to.equal(pinned);
        }
    });

    it('reports drift when one part is edited, and names what the directory holds now', function () {
        const root = tempRoot();
        const dir = splitHandler(root, 'batch');
        const pinned = row('src/actions/batch/', pinOf(root, 'src/actions/batch/'));
        fs.appendFileSync(path.join(dir, 'fees.js'), '// a rule changed here\n');
        const { missing, drift } = dirs.compareRows(root, [pinned]);
        expect(missing).to.deep.equal([]);
        expect(drift).to.have.lengthOf(1);
        expect(drift[0].handler).to.equal('src/actions/batch/');
        expect(dirs.formatDrift(drift[0]), 'the report lists the parts for the re-pin').to.include('fees.js');
    });

    it('reports drift when an unlisted part is added, or a part removed or renamed', function () {
        const root = tempRoot();
        const dir = splitHandler(root, 'batch');
        const pinned = row('src/actions/batch/', pinOf(root, 'src/actions/batch/'));
        put(root, 'src/actions/batch/settle.js', 'module.exports = function settle() {};\n');
        expect(dirs.compareRows(root, [pinned]).drift, 'an added part').to.have.lengthOf(1);
        fs.rmSync(path.join(dir, 'settle.js'));
        expect(dirs.compareRows(root, [pinned]).drift, 'back to the pinned set').to.deep.equal([]);
        fs.rmSync(path.join(dir, 'limits', 'caps.js'));
        expect(dirs.compareRows(root, [pinned]).drift, 'a removed part').to.have.lengthOf(1);
        put(root, 'src/actions/batch/limits/caps_renamed.js', 'module.exports = { MAX_PARTS: 10 };\n');
        expect(dirs.compareRows(root, [pinned]).drift, 'a renamed part, same bytes').to.have.lengthOf(1);
    });
});

describe('drift map rows: split shapes that must fail closed', function () {
    afterEach(cleanRoots);

    it('tells a flat row whose handler became a directory how to re-pin', function () {
        const root = tempRoot();
        splitHandler(root, 'batch');
        const { missing } = dirs.compareRows(root, [row('src/actions/batch.js', ZERO)]);
        expect(missing).to.have.lengthOf(1);
        expect(missing[0]).to.include('now a directory handler');
        expect(missing[0], 'names the row to write').to.include('src/actions/batch/');
    });

    it('refuses a directory row while a flat handler beside it still wins require()', function () {
        // Node resolves require('./batch') to batch.js before batch/index.js, so hashing
        // the directory here would pin code that does not run.
        const root = tempRoot();
        splitHandler(root, 'batch');
        put(root, 'src/actions/batch.js', 'module.exports = {};\n');
        const { missing, drift } = dirs.compareRows(root, [row('src/actions/batch/', pinOf(root, 'src/actions/batch/'))]);
        expect(drift).to.deep.equal([]);
        expect(missing[0]).to.include('is what require() resolves first');
    });

    it('refuses a symbolic link as a part rather than following or skipping it', function () {
        // Followed, it hashes bytes from outside the handler; skipped, it is a part the pin
        // does not cover. Either way the row would stop meaning what it says.
        const root = tempRoot();
        const dir = splitHandler(root, 'batch');
        put(root, 'src/elsewhere.js', 'module.exports = {};\n');
        fs.symlinkSync(path.join(root, 'src', 'elsewhere.js'), path.join(dir, 'linked.js'));
        const { missing } = dirs.compareRows(root, [row('src/actions/batch/', ZERO)]);
        expect(missing).to.have.lengthOf(1);
        expect(missing[0]).to.include('symbolic link');
    });

    it('refuses an empty directory instead of pinning the digest of nothing', function () {
        const root = tempRoot();
        fs.mkdirSync(path.join(root, 'src', 'actions', 'batch'), { recursive: true });
        const { missing } = dirs.compareRows(root, [row('src/actions/batch/', ZERO)]);
        expect(missing[0]).to.include('nothing to hash');
    });
});

describe('fee walk: a directory handler is read whole', function () {
    afterEach(cleanRoots);

    function feeRoot(name) {
        const root = tempRoot();
        put(root, 'src/actions/index.js', '// the action loader\n');
        put(root, `src/actions/${name}.js`, 'await this.util.createFeesObject(this.indexerDb, data, preferences);\n');
        return root;
    }

    it('enrols an action whose createFeesObject call sits in a part, not in index.js', function () {
        // The M3 split moves the call out of the entry; reading index.js alone would report
        // "charges no fee" for a handler that charges one, and the SDK would withhold the
        // NATIVE_FEE_FORFEIT disclosure exactly as it did for BET.
        const root = feeRoot('issue');
        splitHandler(root, 'dividend');
        expect(gate.deriveFeeChargingActions(root)).to.include('DIVIDEND');
    });

    it('enrols on a call in a nested part too', function () {
        const root = feeRoot('issue');
        splitHandler(root, 'swap');
        fs.writeFileSync(path.join(root, 'src', 'actions', 'swap', 'fees.js'), '// no call here now\n');
        put(root, 'src/actions/swap/settle/charge.js', 'await u.createFeesObject(db, d, p);\n');
        expect(gate.deriveFeeChargingActions(root)).to.include('SWAP');
    });

    it('does not enrol a part that only names the helper in a comment', function () {
        const root = feeRoot('issue');
        splitHandler(root, 'send');
        fs.writeFileSync(path.join(root, 'src', 'actions', 'send', 'fees.js'),
            '// createFeesObject is named here in prose only; SEND charges no protocol fee.\n');
        expect(gate.deriveFeeChargingActions(root)).to.not.include('SEND');
    });

    it('fails CLOSED on a fee call in a directory that is not a handler', function () {
        // No index.js means no action name to enrol, so the call would be silently dropped.
        const root = feeRoot('issue');
        put(root, 'src/actions/helpers/charge.js', 'await u.createFeesObject(db, d, p);\n');
        expect(() => gate.deriveFeeChargingActions(root)).to.throw(/no index\.js/);
    });
});

describe('fee-quote literals: found once, wherever the split left them', function () {
    afterEach(cleanRoots);

    const SDK_CONSTANTS = fs.readFileSync(path.join(SDK_ROOT, 'src', 'preflight', 'constants.js'), 'utf8');
    const TIER1 = gate.parseStringSet(SDK_CONSTANTS, 'TIER1_DENYLIST', 'src/preflight/constants.js');
    const set = (name, members) => `const ${name} = new Set([${members.map((a) => `'${a}'`).join(', ')}]);\n`;

    /* An indexer tree whose fee-charging call sites match the SDK's list, with the
     * FEE_QUOTE_DENYLIST literal wherever the caller asks for it. */
    function literalRoot(denylistHome) {
        const root = tempRoot();
        for (const a of gate.parseStringSet(SDK_CONSTANTS, 'FEE_CHARGING_ACTIONS', 'constants.js')) {
            if (a === 'DEPLOY' || a === 'EXECUTE') continue;
            put(root, `src/actions/${a.toLowerCase()}.js`, 'await this.util.createFeesObject(db, d, p);\n');
        }
        put(root, 'src/actions/index.js', set('FEE_QUOTE_STATIC', ['DEPLOY', 'EXECUTE']) + set('FEE_QUOTE_EXEMPT', ['COINPAY']));
        put(root, denylistHome, set('FEE_QUOTE_DENYLIST', TIER1));
        return root;
    }

    it('reads a literal that moved out of the loader into a handler part', function () {
        const root = literalRoot('src/actions/batch/fees.js');
        const read = dirs.indexerLiteralReader(root, gate.parseStringSet);
        expect(read('FEE_QUOTE_DENYLIST')).to.deep.equal(TIER1);
    });

    it('keeps the whole fee-quote seam green with the literal in a part', function () {
        expect(gate.checkFeeQuoteSeam(literalRoot('src/preflight/fee_quote.js'))).to.equal(0);
    });

    it('fails CLOSED on a stale second copy left behind by the move', function () {
        // Two declarations are the hazard the exactly-once rule answers: with more than one,
        // the gate reads whichever copy the walk reaches, so a stale one silently decides
        // the comparison.
        const root = literalRoot('src/preflight/fee_quote.js');
        put(root, 'src/actions/batch/fees.js', set('FEE_QUOTE_DENYLIST', ['BATCH']));
        const read = dirs.indexerLiteralReader(root, gate.parseStringSet);
        expect(() => read('FEE_QUOTE_DENYLIST')).to.throw(/exactly one .* found 2/);
        expect(() => gate.checkFeeQuoteSeam(root)).to.throw(/found 2/);
    });

    it('fails CLOSED when the literal is nowhere under src/', function () {
        const root = literalRoot('src/preflight/fee_quote.js');
        fs.rmSync(path.join(root, 'src', 'preflight', 'fee_quote.js'));
        expect(() => gate.checkFeeQuoteSeam(root)).to.throw(/found 0/);
    });

    it('reports where a duplicate lives, so the stale copy can be found', function () {
        const root = literalRoot('src/preflight/fee_quote.js');
        put(root, 'src/actions/batch/fees.js', set('FEE_QUOTE_DENYLIST', ['BATCH']));
        const read = dirs.indexerLiteralReader(root, gate.parseStringSet);
        expect(() => read('FEE_QUOTE_DENYLIST')).to.throw(/src\/actions\/batch\/fees\.js/);
    });
});
