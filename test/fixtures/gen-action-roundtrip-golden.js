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
 *
 * Regenerator for action-roundtrip-golden.json (the SDK-encoder <->
 * indexer-parser byte-level field-layout contract, item ).
 *
 * Run it only from a full monorepo checkout (needs both xchain-sdk and a
 * sibling xchain-indexer). It drives the live SDK encoder to serialize each
 * input, drives the live indexer positional parser to read the wire back, and
 * asserts the round-trip is byte-clean before writing. A wire change is a
 * consensus-visible protocol change, so a diff in the emitted JSON must be
 * reviewed as one. After regenerating, copy the file over the vendored
 * xchain-indexer/test/fixtures/ copy so the two stay byte-identical.
 *
 *   node test/fixtures/gen-action-roundtrip-golden.js
 *
 ********************************************************************/

const path   = require('path');
const fs     = require('fs');
const assert = require('assert');

const SDK_ROOT = path.join(__dirname, '..', '..');                 // xchain-sdk
const IDX_ROOT = path.join(SDK_ROOT, '..', 'xchain-indexer');       // sibling

const sdkConfig  = require(path.join(SDK_ROOT, 'src', 'config.js'));
const SdkUtility = require(path.join(SDK_ROOT, 'src', 'utility.js'));
const Actions    = require(path.join(SDK_ROOT, 'src', 'actions.js'));
function makeActions() {
    return new Actions({ config: sdkConfig.getConfig(), util: new SdkUtility() });
}

// Indexer parser side (mirrors XChainIndexer processTransaction's parse path).
process.env.INDEXER_COIN    = process.env.INDEXER_COIN    || 'BTC';
process.env.INDEXER_NETWORK = process.env.INDEXER_NETWORK || 'regtest';
const IdxUtility  = require(path.join(IDX_ROOT, 'src', 'utility.js'));
const ACTIONS_DIR = path.join(IDX_ROOT, 'src', 'actions');
const STUB = { config: {}, decoderDb: null, indexerDb: null, util: null, mapper: null };

function loadHandlerFormats() {
    const out = {};
    for (const file of fs.readdirSync(ACTIONS_DIR)) {
        if (!file.endsWith('.js') || file === 'README.md') continue;
        let Handler, inst;
        try { Handler = require(path.join(ACTIONS_DIR, file)); } catch (_) { continue; }
        if (typeof Handler !== 'function') continue;
        try { inst = new Handler(STUB); } catch (_) { continue; }
        if (inst && inst.formats && typeof inst.formats === 'object' && Object.keys(inst.formats).length)
            out[file.replace(/\.js$/, '')] = inst.formats;
    }
    return out;
}

const util    = new IdxUtility();
const FORMATS = loadHandlerFormats();
const formatsFor = (action) => FORMATS[action.toLowerCase()] || null;

function indexerParse(wire, formats) {
    let params = String(wire).split('|').map((v) => String(v).trim());
    let action = String(params.shift()).toUpperCase();
    if (['ISSUE', 'MINT', 'SEND'].includes(action) && util.isLegacyActionFormat(params))
        params.splice(0, 0, 0);
    let format = util.getFormatVersion(params[0]);
    let data   = util.setActionParams({}, params, formats, format);
    return { action, format, data };
}

const A   = 'mqmJDcs5nXFHrj9q7a2G5sBVmjcQTDdUZp';
const PUB = 'a'.repeat(64); // 64-char hex Ed25519 signing pubkey

// Fixed-arity single-group cases (see coverage_note in the emitted JSON).
const CASES = [
    ['ISSUE full v0',  'ISSUE',     { tick: 'GOLDTOKEN', maxSupply: '21000000', maxMint: '1000', decimals: 8, description: 'gold token', mintSupply: '1000', lockMaxSupply: 1, memo: 'hello' }],
    ['ISSUE brief v1', 'ISSUE',     { tick: 'BRRR', description: 'brrr desc', memo: 'm', version: 1 }],
    ['SEND v0',        'SEND',      { tick: 'GOLDTOKEN', amount: '100', destination: A, memo: 'pay' }],
    ['MINT v0',        'MINT',      { tick: 'GOLDTOKEN', amount: '500', destination: A, memo: 'mint' }],
    ['DESTROY v0',     'DESTROY',   { tick: 'GOLDTOKEN', amount: '5', memo: 'burn' }],
    ['ORDER v0',       'ORDER',     { giveTick: 'GOLDTOKEN', giveAmount: '5', getTick: 'BRRR', getAmount: '10', expiration: '100', memo: 'o' }],
    ['SWAP v0',        'SWAP',      { giveTick: 'GOLDTOKEN', giveAmount: '5', getTick: 'BRRR', getAmount: '10', expiration: '100', memo: 's' }],
    ['DISPENSER v0',   'DISPENSER', { giveTick: 'GOLDTOKEN', giveAmount: '5', getCoin: 'BTC', getAmount: '100000', getAddress: A, expiration: '500', memo: 'd' }],
    ['SWEEP v0',       'SWEEP',     { destination: A, balances: 1, ownerships: 0, orders: 1, swaps: 1, dispensers: 0, memo: 'sw' }],
    ['STAKE v1',       'STAKE',     { amount: '1000', signingPubkey: PUB, version: 1 }],
    ['UNSTAKE v0',     'UNSTAKE',   { signingPubkey: PUB }],
    ['DELEGATE v0',    'DELEGATE',  { newSigningPubkey: PUB }],
    ['DEPOSIT v0',     'DEPOSIT',   { contractActionIndex: '42', tick: 'GOLDTOKEN', quantity: '250' }],
    ['WITHDRAW v0',    'WITHDRAW',  { contractActionIndex: '42', tick: 'GOLDTOKEN', quantity: '250' }],
    ['DIVIDEND v0',    'DIVIDEND',  { tick: 'GOLDTOKEN', dividendTick: 'BRRR', amount: '3', memo: 'div' }],
    ['LINK v0',        'LINK',      { coin1: 'BTC', coin1ActionIndex: '10', coin2: 'LTC', coin2ActionIndex: '20', memo: 'l' }],
    ['SLEEP v0',       'SLEEP',     { resumeBlock: '900000', memo: 'zzz' }],
    ['BROADCAST v0',   'BROADCAST', { message: 'hello world', value: '42' }],
    ['ADDRESS v0',     'ADDRESS',   { feePreference: 1, requireMemo: 0, dispenserPreference: 1, memo: 'a' }],
];

const vectors = [];
for (const [label, action, input] of CASES) {
    const res    = makeActions().createAction({ action, params: input });
    const fmts   = formatsFor(action);
    assert.ok(fmts, `no indexer handler formats for ${action}`);
    const parsed = indexerParse(res.actionString, fmts);

    // Round-trip identity: every SDK field lands at the right parsed slot, the
    // version agrees, and no unexpected non-null field appears.
    assert.strictEqual(parsed.action, action, `${label}: action`);
    assert.strictEqual(String(parsed.format), String(res.version), `${label}: version`);
    assert.strictEqual(String(parsed.data.VERSION), String(res.version), `${label}: VERSION field`);
    for (const k of Object.keys(res.fields))
        assert.strictEqual(String(parsed.data[k]), String(res.fields[k]), `${label}: field ${k}`);
    for (const k of Object.keys(parsed.data)) {
        if (k === 'VERSION') continue;
        if (parsed.data[k] !== null)
            assert.ok(k in res.fields, `${label}: unexpected non-null parsed field ${k}`);
    }

    vectors.push({ label, action, version: res.version, input, wire: res.actionString, parsed: parsed.data });
}

const doc = {
    '$schema_note': 'Byte-level field-layout contract between the xchain-sdk ACTION encoder (producer) and the xchain-indexer positional parser (consumer). Each vector pins one action/version\'s canonical wire string. The SDK must serialize `input` to exactly `wire`; the indexer\'s setActionParams must parse `wire` into exactly `parsed`. Both together prove producer and consumer agree on every field\'s byte position. Regenerate with xchain-sdk/test/fixtures/gen-action-roundtrip-golden.js after an intentional wire-format change; a diff here is a consensus-visible wire change and must be reviewed as one.',
    'authority': 'Vendored byte-identical into xchain-sdk/test/fixtures/ and xchain-indexer/test/fixtures/ so each repo\'s unit CI pins its own half without a sibling checkout. The two copies MUST stay identical; each side\'s test asserts byte-identity when the sibling checkout is present.',
    'coverage_note': 'Fixed-arity single-group formats only. Rest-field / repeating-group layouts (SEND v1-v3, LIST ...ITEM, EXECUTE ...PARAMS, DEPLOY ...CONSTRUCTOR_PARAMS, multi-recipient AIRDROP/DIVIDEND) are intentionally excluded: the indexer\'s positional setActionParams does not map them 1:1 (handlers parse those with custom logic), so they are not a clean round-trip through this codec. Includes the 2026-05 breaking-format actions (ORDER/SWAP/DISPENSER ownership flags, SWEEP escrow flags, STAKE/UNSTAKE/DELEGATE capability model) whose field insertions are exactly the byte-shift regressions this contract guards.',
    vectors,
};

const OUT = path.join(__dirname, 'action-roundtrip-golden.json');
fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${vectors.length} vectors -> ${OUT}`);
console.log('remember: copy this file over xchain-indexer/test/fixtures/action-roundtrip-golden.json (byte-identical vendoring).');
