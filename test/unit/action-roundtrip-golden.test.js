'use strict';

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
 * SDK-encoder <-> indexer-parser byte-level field-layout contract .
 *
 * The encoder is a byte-blind transport: nothing in the manifest conformance
 * system asserts that an SDK-serialized ACTION's byte layout is the exact
 * layout the indexer's positional parser reads. On the wire an ACTION is a
 * pipe-delimited `ACTION|VERSION|FIELD...` string; the SDK builds it from a
 * field map and the indexer maps the split params back positionally using its
 * per-handler `formats[version]` template. A silent divergence (a field
 * inserted on one side only, the exact 2026-05 ORDER/SWAP/DISPENSER/SWEEP/
 * STAKE breaking-format hazard) mis-parses every affected action network-wide.
 *
 * This suite pins the ENCODER half against committed golden wire strings, so
 * an SDK field-order change fails CI here. When a sibling xchain-indexer
 * checkout is present it also drives the live indexer parser to confirm both
 * sides still agree byte-for-byte (the full round-trip), and asserts the two
 * vendored golden copies are byte-identical.
 ********************************************************************/

const { expect } = require('chai');
const fs         = require('fs');
const path       = require('path');

const config   = require('../../src/config.js');
const Utility   = require('../../src/utility.js');
const Actions   = require('../../src/actions.js');

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'action-roundtrip-golden.json');
const GOLDEN       = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

function makeActions() {
    return new Actions({ config: config.getConfig(), util: new Utility() });
}

// Resolve a sibling xchain-indexer checkout (XCHAIN_INDEXER_PATH first, then
// the monorepo sibling layout). Returns null when absent so the unit tier,
// which checks out only this repo, degrades to the encoder-half pin.
function resolveIndexerRoot() {
    const candidates = [
        process.env.XCHAIN_INDEXER_PATH,
        path.join(__dirname, '..', '..', '..', 'xchain-indexer'),
    ].filter(Boolean);
    for (const root of candidates) {
        if (fs.existsSync(path.join(root, 'src', 'utility.js')) &&
            fs.existsSync(path.join(root, 'src', 'actions')))
            return root;
    }
    return null;
}

// Build the indexer's positional parser (mirrors XChainIndexer.processTransaction).
function buildIndexerParser(indexerRoot) {
    process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
    process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
    const IdxUtility  = require(path.join(indexerRoot, 'src', 'utility.js'));
    const ACTIONS_DIR = path.join(indexerRoot, 'src', 'actions');
    const STUB = { config: {}, decoderDb: null, indexerDb: null, util: null, mapper: null };

    const formats = {};
    for (const file of fs.readdirSync(ACTIONS_DIR)) {
        if (!file.endsWith('.js') || file === 'README.md') continue;
        let Handler, inst;
        try { Handler = require(path.join(ACTIONS_DIR, file)); } catch (_) { continue; }
        if (typeof Handler !== 'function') continue;
        try { inst = new Handler(STUB); } catch (_) { continue; }
        if (inst && inst.formats && typeof inst.formats === 'object' && Object.keys(inst.formats).length)
            formats[file.replace(/\.js$/, '')] = inst.formats;
    }

    const util = new IdxUtility();
    return function parse(wire) {
        const fmts = formats[String(wire).split('|')[0].toLowerCase()];
        let params = String(wire).split('|').map((v) => String(v).trim());
        let action = String(params.shift()).toUpperCase();
        if (['ISSUE', 'MINT', 'SEND'].includes(action) && util.isLegacyActionFormat(params))
            params.splice(0, 0, 0);
        let format = util.getFormatVersion(params[0]);
        let data   = util.setActionParams({}, params, fmts, format);
        return { action, format, data };
    };
}

describe('Action round-trip golden – SDK encoder byte-layout contract', function () {

    it('loads a representative set of golden vectors', function () {
        expect(GOLDEN.vectors).to.be.an('array');
        expect(GOLDEN.vectors.length).to.be.at.least(15);
    });

    describe('SDK encoder serializes each input to the exact golden wire string', function () {
        for (const vec of GOLDEN.vectors) {
            it(`${vec.label}: createAction() -> canonical wire`, function () {
                const res = makeActions().createAction({ action: vec.action, params: vec.input });
                expect(res.actionString).to.equal(vec.wire, `${vec.label} wire layout drifted`);
                expect(res.version).to.equal(vec.version, `${vec.label} format version`);
            });
        }
    });

    describe('full round-trip against a live indexer parser (when sibling present)', function () {
        const indexerRoot = resolveIndexerRoot();
        let parse = null;
        before(function () {
            if (!indexerRoot) {
                this.skip(); // unit tier: no sibling indexer checkout
                return;
            }
            parse = buildIndexerParser(indexerRoot);
        });

        it('the two vendored golden copies are byte-identical', function () {
            if (!indexerRoot) this.skip();
            const sibling = fs.readFileSync(path.join(indexerRoot, 'test', 'fixtures', 'action-roundtrip-golden.json'), 'utf8');
            expect(sibling).to.equal(fs.readFileSync(FIXTURE_PATH, 'utf8'), 'vendored golden copies drifted');
        });

        for (const vec of GOLDEN.vectors) {
            it(`${vec.label}: SDK wire parses back to every input field`, function () {
                if (!parse) this.skip();
                const res    = makeActions().createAction({ action: vec.action, params: vec.input });
                const parsed = parse(res.actionString);
                expect(parsed.action).to.equal(vec.action);
                expect(String(parsed.format)).to.equal(String(vec.version));
                expect(parsed.data).to.deep.equal(vec.parsed, `${vec.label} parser layout drifted`);
                // Round-trip identity: what the SDK put in, the indexer reads out.
                for (const k of Object.keys(res.fields))
                    expect(String(parsed.data[k])).to.equal(String(res.fields[k]), `${vec.label} field ${k} did not round-trip`);
            });
        }
    });
});
