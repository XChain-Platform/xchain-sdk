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
 * ISSUE format 7 (the token-bridge opt-in) must be PURELY ADDITIVE.
 *
 * Why this file exists, and why it does not just lean on the golden: adding
 * format 7 made the golden's `parsed` blobs grow three keys, because the
 * indexer's setActionParams() null-fills the UNION of every format version's
 * field names. Updating the golden to match is the correct move only if the
 * older versions are provably untouched; if the same edit could hide a real
 * v0/v1 layout change, updating the golden would be laundering a fork. So the
 * pre-change bytes are FROZEN HERE, lifted from the golden as it stood before
 * format 7 landed, and asserted independently of the golden file. An edit that
 * regenerates the golden can never quietly move these.
 *
 * What it pins, in order of consensus weight:
 *   1. The ISSUE format strings for versions 0 to 6, byte for byte. A field
 *      inserted, renamed or reordered in an OLD version re-parses every ISSUE
 *      already on chain, which is a fork.
 *   2. The canonical wire an ISSUE v0 and an ISSUE v1 serialize to, byte for
 *      byte, against the pre-format-7 golden strings.
 *   3. When a sibling xchain-indexer checkout is present: every field the
 *      pre-change parser produced still parses to the same value, and the only
 *      difference in the parsed map is the three format-7 field names arriving
 *      as null. Anything else is a layout change, not a union-fill artifact.
 ********************************************************************/

const { expect } = require('chai');
const fs         = require('fs');
const path       = require('path');

const config  = require('../../src/config.js');
const Utility = require('../../src/utility.js');
const Actions = require('../../src/actions.js');
const Formats = require('../../src/formats.js');

// The ISSUE format table exactly as it shipped before format 7 was added
// (xchain-sdk/src/formats.js at the commit that preceded this wave). Frozen
// literals, never read from src, so a change in src cannot move the expectation.
const PRE_CHANGE_ISSUE_FORMATS = {
    0: 'VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO',
    1: 'VERSION|TICK|DESCRIPTION|MEMO',
    2: 'VERSION|TICK|MAX_MINT|MINT_SUPPLY|TRANSFER_SUPPLY|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|MEMO',
    3: 'VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO',
    4: 'VERSION|TICK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|MEMO',
    5: 'VERSION|TICK|ALLOW_LIST|BLOCK_LIST|MEMO',
    6: 'VERSION|TICK|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO',
};

// The field names format 7 introduces. These are the ONLY names allowed to
// appear in a v0 or v1 parsed map that were not there before, and only as null.
const FORMAT_7_NEW_FIELDS = ['BRIDGE_CHAINS', 'MIN_DEPTH', 'LOCK_BRIDGE'];

// The two ISSUE vectors as the golden held them before format 7: the same
// inputs, the same canonical wire, the same parsed map. Copied verbatim from
// `git show <pre-wave HEAD>:test/fixtures/action-roundtrip-golden.json`.
const PRE_CHANGE_VECTORS = [
    {
        label: 'ISSUE full v0',
        version: 0,
        input: {
            tick: 'GOLDTOKEN', maxSupply: '21000000', maxMint: '1000', decimals: 8,
            description: 'gold token', mintSupply: '1000', lockMaxSupply: 1, memo: 'hello',
        },
        wire: 'ISSUE|0|GOLDTOKEN|21000000|1000|8|gold token|1000|||1|||||||||||||||hello',
        parsed: {
            VERSION: '0', TICK: 'GOLDTOKEN', MAX_SUPPLY: '21000000', MAX_MINT: '1000',
            DECIMALS: '8', DESCRIPTION: 'gold token', MINT_SUPPLY: '1000', TRANSFER: null,
            TRANSFER_SUPPLY: null, LOCK_MAX_SUPPLY: '1', LOCK_MAX_MINT: null,
            LOCK_DESCRIPTION: null, LOCK_SLEEP: null, LOCK_CALLBACK: null,
            CALLBACK_BLOCK: null, CALLBACK_TICK: null, CALLBACK_AMOUNT: null,
            ALLOW_LIST: null, BLOCK_LIST: null, MINT_ADDRESS_MAX: null,
            MINT_START_BLOCK: null, MINT_STOP_BLOCK: null, LOCK_MINT: null,
            LOCK_MINT_SUPPLY: null, MEMO: 'hello', CONTROLLER: null, ACTION_CLASS: null,
            COOLDOWN_BLOCKS: null, UNBIND: null,
        },
    },
    {
        label: 'ISSUE brief v1',
        version: 1,
        input: { tick: 'BRRR', description: 'brrr desc', memo: 'm', version: 1 },
        wire: 'ISSUE|1|BRRR|brrr desc|m',
        parsed: {
            VERSION: '1', TICK: 'BRRR', DESCRIPTION: 'brrr desc', MEMO: 'm',
            MAX_SUPPLY: null, MAX_MINT: null, DECIMALS: null, MINT_SUPPLY: null,
            TRANSFER: null, TRANSFER_SUPPLY: null, LOCK_MAX_SUPPLY: null,
            LOCK_MAX_MINT: null, LOCK_DESCRIPTION: null, LOCK_SLEEP: null,
            LOCK_CALLBACK: null, CALLBACK_BLOCK: null, CALLBACK_TICK: null,
            CALLBACK_AMOUNT: null, ALLOW_LIST: null, BLOCK_LIST: null,
            MINT_ADDRESS_MAX: null, MINT_START_BLOCK: null, MINT_STOP_BLOCK: null,
            LOCK_MINT: null, LOCK_MINT_SUPPLY: null, CONTROLLER: null,
            ACTION_CLASS: null, COOLDOWN_BLOCKS: null, UNBIND: null,
        },
    },
];

function makeActions() {
    return new Actions({ config: config.getConfig(), util: new Utility() });
}

// Same sibling resolution the golden suite uses: the unit tier checks out only
// this repo, so the parser half degrades to a skip rather than a false red.
function resolveIndexerRoot() {
    const candidates = [
        process.env.XCHAIN_INDEXER_PATH,
        path.join(__dirname, '..', '..', '..', 'xchain-indexer'),
    ].filter(Boolean);
    for (const root of candidates) {
        if (fs.existsSync(path.join(root, 'src', 'utility.js')) &&
            fs.existsSync(path.join(root, 'src', 'actions', 'issue.js')))
            return root;
    }
    return null;
}

describe('ISSUE format 7 is purely additive (pre-change pin)', function () {

    describe('the SDK ISSUE format table for versions 0 to 6 is byte-identical to its pre-format-7 text', function () {
        for (const version of Object.keys(PRE_CHANGE_ISSUE_FORMATS)) {
            it(`ISSUE format ${version} is unchanged`, function () {
                expect(Formats.ISSUE[version]).to.equal(
                    PRE_CHANGE_ISSUE_FORMATS[version],
                    `ISSUE format ${version} moved. Every ISSUE already on chain re-parses under the new ` +
                    'template, which is a fork, not a format addition.');
            });
        }
    });

    it('format 7 is an addition, not a replacement: no old version was removed', function () {
        for (const version of Object.keys(PRE_CHANGE_ISSUE_FORMATS))
            expect(Formats.ISSUE).to.have.property(version);
        expect(Formats.ISSUE).to.have.property('7');
    });

    describe('the canonical wire an old-version ISSUE serializes to is byte-identical', function () {
        for (const vec of PRE_CHANGE_VECTORS) {
            it(`${vec.label}: encodes to the pre-format-7 wire, byte for byte`, function () {
                const res = makeActions().createAction({ action: 'ISSUE', params: vec.input });
                expect(res.actionString).to.equal(vec.wire, `${vec.label} wire drifted after format 7 landed`);
                expect(String(res.version)).to.equal(String(vec.version), `${vec.label} format version drifted`);
            });
        }
    });

    describe('the sibling indexer parses an old-version ISSUE to the same values it always did', function () {
        const indexerRoot = resolveIndexerRoot();
        let parse = null;

        before(function () {
            // Cross-repo require of the sibling handler and utility; synchronous,
            // so mocha's timer could only mis-attribute a slow load, never stop it.
            this.timeout(0);
            if (!indexerRoot) { this.skip(); return; }
            process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
            process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
            const IdxUtility = require(path.join(indexerRoot, 'src', 'utility.js'));
            const Issue      = require(path.join(indexerRoot, 'src', 'actions', 'issue.js'));
            const formats    = new Issue({ config: {}, decoderDb: null, indexerDb: null, util: null, mapper: null }).formats;
            const util       = new IdxUtility();
            parse = function (wire) {
                let params = String(wire).split('|').map((v) => String(v).trim());
                String(params.shift());
                if (util.isLegacyActionFormat(params)) params.splice(0, 0, 0);
                const format = util.getFormatVersion(params[0]);
                return { format, data: util.setActionParams({}, params, formats, format) };
            };
        });

        for (const vec of PRE_CHANGE_VECTORS) {
            it(`${vec.label}: every pre-change field parses to the same value`, function () {
                if (!parse) this.skip();
                const res    = makeActions().createAction({ action: 'ISSUE', params: vec.input });
                const parsed = parse(res.actionString);
                expect(String(parsed.format)).to.equal(String(vec.version));
                for (const field of Object.keys(vec.parsed))
                    expect(parsed.data[field]).to.equal(
                        vec.parsed[field],
                        `${vec.label}: field ${field} parses differently than it did before format 7`);
            });

            it(`${vec.label}: the only new keys are the format-7 fields, all null`, function () {
                if (!parse) this.skip();
                const res    = makeActions().createAction({ action: 'ISSUE', params: vec.input });
                const parsed = parse(res.actionString);
                const added  = Object.keys(parsed.data).filter((k) => !(k in vec.parsed));
                // setActionParams null-fills the union of every format's field names, so a
                // new format legitimately adds ITS OWN names as null. Any other new key, or
                // a non-null value on one of these, means a v0/v1 field moved.
                expect(added.slice().sort()).to.deep.equal(
                    FORMAT_7_NEW_FIELDS.slice().sort(),
                    `${vec.label}: parsed map gained keys beyond the format-7 fields`);
                for (const field of added)
                    expect(parsed.data[field]).to.equal(
                        null, `${vec.label}: ${field} is not null on an old-version ISSUE`);
            });
        }
    });
});
