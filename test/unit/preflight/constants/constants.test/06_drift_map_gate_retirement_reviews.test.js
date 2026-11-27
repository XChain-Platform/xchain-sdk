'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gate retirement reviews of the pre-flight drift map (spec §8.5). Each retirement that
// re-pins a mapped handler records a dated review entry; these cases pin the hashes that
// entry names and the entry's direction line. They live beside 01_drift_map.test.js,
// which is at the part-file line cap.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { parseMap } = require('../../../../../bin/check-preflight-drift.js');

const REAL_MAP = path.join(__dirname, '..', '..', '..', '..', '..', 'src', 'preflight', 'INDEXER-MAP.md');
// The live batch pin; every review that re-pinned batch checks the map still carries it.
const BATCH_PIN = 'ffabf6745abe572be6405f939424612e42c399dcbf40704a5bb38f812ed73bae';

function entryOf(text, heading) {
    const start = text.indexOf(heading);
    return text.slice(start, text.indexOf('\n### ', start + heading.length));
}

function dispenserPositivityReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    expect(rows.find((r) => r.handler === 'src/actions/dispenser/'), 'dispenser directory row').to.exist;
    expect(rows.find((r) => r.handler === 'src/actions/dispense/').hash)
        .to.equal('302ff0ba22c0ce8953db67b2eea23223162e4823302bd191ad8058ac52824cdc');
    const heading = '### 2026-10-18 - DISPENSER_AMOUNT_POSITIVITY gate is retired';
    expect(text).to.include(heading);
    expect(entryOf(text, heading)).to.include('**Direction: NEUTRAL.**');
}

function dispenserPinChainEnd() {
    const text = fs.readFileSync(REAL_MAP, 'utf8').replace(/\s+/g, ' ');
    const dispenser = parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/dispenser/');
    expect(dispenser, 'dispenser directory row').to.exist;
    const moves = [...text.matchAll(/the `dispenser` pin moves from `([0-9a-f]{8})` to `([0-9a-f]{8})`/gi)];
    const live = dispenser.hash.slice(0, 8);
    expect(moves.map((move) => move[2]), 'review-log destination pins').to.include(live);
    expect(moves.map((move) => move[1]), 'superseded review-log pins').to.not.include(live);
}

function airdropFeeTallyReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/airdrop/').hash)
        .to.equal('188c409ef4027a2291657c4db6050f72c3921bd0ae43f01d7ea03dfc6f7d7ace');
    const heading = '### 2026-10-18 - AIRDROP_NATIVE_FEE_TALLY gate is added';
    expect(text).to.include(heading);
    expect(entryOf(text, heading)).to.include('**Direction: TIGHTENING at the gate height only.**');
}

function sendHandoffRetirementReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/send/').hash)
        .to.equal('3e4d1e274403cac24057c65453cf2168f5fc761fe15bf6f048aa01cf5a73cdc8');
    const heading = '### 2026-10-18 - GATED_HANDOFF_REF gate is retired';
    expect(text).to.include(heading);
    expect(entryOf(text, heading)).to.include('**Direction: NEUTRAL.**');
}

// The batch pin follows the hash origin develop carries, so each entry must name the pairing.
function batchSnapshotReviews() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/batch/').hash).to.equal(BATCH_PIN);
    const reviews = [
        ['### 2026-10-19 - BATCH probe sub-verdicts carry their own match snapshot', '`7e138a16` to `e7d7825d`'],
        ['### 2026-10-20 - a BATCH\'s own status is restored off the probe path too', '`e7d7825d` to `9f1e45a3`']
    ];
    for (const [heading, move] of reviews) {
        expect(text).to.include(heading);
        const entry = entryOf(text, heading).replace(/\s+/g, ' ');
        expect(entry).to.include('The `batch` pin moves from ' + move);
        expect(entry).to.include('cross-repo pairing exception');
        expect(entry).to.include('**Direction: NEUTRAL** for validity.');
        expect(entry).to.include('NO CLIENT CHECK MOVES');
    }
}

// The send, destroy and mint pins move ahead of their indexer commit, so the entry names the pairing.
function gasBalanceReadReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    const moves = [
        ['send', '`ee30f903` to `0cbeede9`', '3e4d1e274403cac24057c65453cf2168f5fc761fe15bf6f048aa01cf5a73cdc8'],
        ['destroy', '`597c2728` to `b172b6cc`', 'a52180e45cacbbb02ee302391bbff6c95eecdee68d6e62b8da97bc25eeb9b348'],
        ['mint', '`f69fdb91` to `998c2d88`', '8321748e950c0ee3e0b2fdd3a73105e920c6f37714912d97847024841a918e53']
    ];
    const heading = '### 2026-10-20 - SEND, DESTROY and MINT read only the gas token\'s balance';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    for (const [name, move, hash] of moves) {
        expect(rows.find((r) => r.handler === 'src/actions/' + name + '/').hash).to.equal(hash);
        expect(entry).to.include('`' + name + '` from ' + move);
    }
    expect(entry).to.include('cross-repo pairing exception');
    expect(entry).to.include('**Direction: NEUTRAL** for validity.');
    expect(entry).to.include('NO CLIENT CHECK MOVES');
}

// The three 2026-10-23 activations: AIRDROP and DIVIDEND move their pins for the reviewed
// settlement changes, while the equal-price ORDER ranking sits outside every mapped row.
function october23GatesReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    expect(rows.find((r) => r.handler === 'src/actions/airdrop/').hash)
        .to.equal('188c409ef4027a2291657c4db6050f72c3921bd0ae43f01d7ea03dfc6f7d7ace');
    expect(rows.find((r) => r.handler === 'src/actions/dividend/').hash)
        .to.equal('6f30915832b6c50d037914f9a0bd58f9d9ab72cc4ea926fd27aec114a99b094c');
    expect(rows.find((r) => r.handler.startsWith('src/actions/order_match')), 'no ORDER_MATCH row').to.equal(undefined);
    const expected = [
        ['### 2026-10-23 - AIRDROP_ZERO_LEGS_OMITTED gate is wired into the AIRDROP settlement',
            'AIRDROP_ZERO_LEGS_OMITTED_ACTIVATION', '**Direction: NEUTRAL for validity; ledger rows change at the gate height only.**'],
        ['### 2026-10-23 - DIVIDEND_EMPTY_ALLOW_LIST_DENIES gate is wired into the DIVIDEND recipient set',
            'DIVIDEND_EMPTY_ALLOW_LIST_DENIES_ACTIVATION', '**Direction: NARROWS the recipient set at the gate height only.**'],
        ['### 2026-10-23 - ORDER matching takes equal-price makers oldest first behind an activation',
            'MATCH_EQUAL_PRICE_OLDEST_FIRST', '**Direction: NEUTRAL for validity, outside every mapped row.**'],
    ];
    for (const [heading, gate, direction] of expected) {
        expect(text).to.include(heading);
        const start = text.indexOf(heading);
        const entry = text.slice(start, text.indexOf('\n### ', start + heading.length));
        expect(entry, heading).to.include(gate);
        expect(entry, heading).to.include(direction);
        expect(entry, heading).to.include('NO CLIENT CHECK MOVES');
    }
}

// The NOT NULL follow-up re-pins send, destroy and stake ahead of indexer dc4e4544f; one STAKE
// check moves, and the SEND and DESTROY legs stay with the server.
function notNullAmountWidthReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    const moves = [
        ['send', '`6bd08ac4` to `82c77168`', '3e4d1e274403cac24057c65453cf2168f5fc761fe15bf6f048aa01cf5a73cdc8'],
        ['destroy', '`56a05750` to `f6423fc8`', 'a52180e45cacbbb02ee302391bbff6c95eecdee68d6e62b8da97bc25eeb9b348'],
        ['stake', '`eef1360e` to `b38ea784`', '791da27d6f8a49fc3498344b8a6bc4044bf9bdf4ff5811d88c9503077845e025'],
    ];
    const heading = '### 2026-10-23 - SEND, DESTROY and STAKE refuse amounts their NOT NULL row columns cannot store';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    for (const [name, move, hash] of moves) {
        expect(rows.find((r) => r.handler === 'src/actions/' + name + '/').hash, name).to.equal(hash);
        expect(entry).to.match(new RegExp('`' + name + '` pin (moves )?from ' + move));
    }
    expect(entry).to.include('committed indexer lane tree `dc4e4544f`');
    expect(entry).to.include('cross-repo pairing exception');
    expect(entry).to.include('**Direction: WIDENS rejection of malformed wire input, no activation row.**');
    expect(entry).to.include('For SEND and DESTROY, NO CLIENT CHECK MOVES');
    expect(entry).to.include('checks.test/18_stake_amount_column_width.test.js');
    expect(entry).to.include('The anchor stays at `52a82367`.');
}

// The TICK_NORMALIZE gate re-pinned issue ahead of indexer 32b4fa8f0, and the 2026-11-02 prefixed
// mint window review pins it now; one ISSUE pre-flight warning
// moves, and the ticker key widening stays outside every mapped row.
function tickNormalizeReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/issue/').hash)
        .to.equal('259d00551b5985147a3f253245fb6705362dd53fc248d468b69979f77f93c978');
    const heading = '### 2026-10-23 - ISSUE caret TICK ids must be canonical behind TICK_NORMALIZE';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    expect(entry).to.include('The `issue` pin moves from `be5cd48c` to `c7d81c14`');
    expect(entry).to.include('committed indexer lane tree `32b4fa8f0`');
    expect(entry).to.include('cross-repo pairing exception');
    expect(entry).to.include('tick_normalize_activation.TICK_NORMALIZE_ACTIVATION');
    expect(entry).to.include('XC_TICK_NORMALIZE_REGTEST_ACTIVATION');
    expect(entry).to.include('One client check moves.');
    expect(entry).to.include('checks.test/19_issue_caret_tick_normalize.test.js');
    expect(entry).to.include('**Direction: TIGHTENING at the gate height only.**');
    expect(entry).to.include('The anchor stays at `52a82367`.');
}

function sameTokenOfferReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    const expected = {
        'src/actions/order/': 'faa64e31b2a882a6f337db72069b5b5bb8e0ef253f8a15916d5c1626b5d1088b',
        'src/actions/swap/': '93af1143be284be5bd2007ab4b8f0df509065ece59367bcbd737648d7134939e',
    };
    for (const [handler, hash] of Object.entries(expected))
        expect(rows.find((row) => row.handler === handler).hash, handler).to.equal(hash);
    const heading = '### 2026-10-27 - same-chain ORDER and SWAP refuse offers of one resolved token';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading);
    expect(entry).to.include('invalid: cannot trade a token for itself');
    expect(entry).to.include('**Direction: WIDENS rejection behind an activation row.**');
}

// The column-width refusals re-pinned issue, price and bet; the prefixed integer review below
// pins issue and bet now, and holds the anchor.
function columnWidthReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    const moves = [
        ['issue', '`c7d81c14` to `37ac3260`'],
        ['price', '`9028c8c2` to `0b7385b1`'],
        ['bet', '`59ff86ee` to `1afee772`'],
    ];
    const heading = '### 2026-11-02 - ISSUE, PRICE v1 and BET refuse valid wire text wider than its column';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    for (const [name, move] of moves)
        expect(entry).to.match(new RegExp('`' + name + '` pin (moves )?from ' + move));
    expect(rows.find((r) => r.handler === 'src/actions/price/').hash)
        .to.equal('0b7385b14af8430c951e586eb2ec7955eee24d6189a15a25830cb133548aec62');
    expect(entry).to.include('issue/stored_widths.js');
    expect(entry).to.include('universal/column_widths.js');
    expect(entry).to.include('**Direction: TIGHTENING, ungated.**');
}

// The hexadecimal, binary and octal integer refusals re-pinned issue, dispenser, order, swap and
// bet; the prefixed mint window review below pins issue now, and holds the anchor.
function prefixedIntegerReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    const moves = [
        ['issue', '`37ac3260` to `48e96f75`', null],
        ['dispenser', '`3c0163d6` to `8130c1a2`', '65209162a134ea9d067ccff5e0ed5127bdc3397ec72ff9efde2ef7cb86542a3a'],
        ['order', '`294bc04f` to `86b0a7c3`', 'faa64e31b2a882a6f337db72069b5b5bb8e0ef253f8a15916d5c1626b5d1088b'],
        ['swap', '`1f77aa82` to `2ee469e1`', '93af1143be284be5bd2007ab4b8f0df509065ece59367bcbd737648d7134939e'],
        ['bet', '`1afee772` to `d1d5a599`', 'd1d5a599a1f9031c54d4c5f163b78007eb983090f406e241a0a7480e730eb8ad'],
    ];
    const heading = '### 2026-11-02 - ISSUE, DISPENSER, ORDER, SWAP and BET refuse hexadecimal, binary and octal '
        + 'integer fields';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    for (const [name, move, hash] of moves) {
        if (hash) expect(rows.find((r) => r.handler === 'src/actions/' + name + '/').hash, name).to.equal(hash);
        expect(entry).to.match(new RegExp('`' + name + '` pin (moves )?from ' + move));
    }
    expect(entry).to.include('util.keepsPrefixedSpelling');
    expect(entry).to.include('universal/prefixed_integers.js');
    expect(entry).to.include('indexer_value_checks_parity.test.js');
    expect(entry).to.include('**Direction: TIGHTENING, ungated.**');
}

// The prefixed mint window refusal re-pins issue and moves the anchor to the committed indexer tree.
function mintWindowReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/issue/').hash)
        .to.equal('259d00551b5985147a3f253245fb6705362dd53fc248d468b69979f77f93c978');
    const heading = '### 2026-11-02 - ISSUE refuses a hexadecimal, binary or octal mint window';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    expect(entry).to.include('The `issue` pin moves from `48e96f75` to `259d0055`');
    expect(entry).to.include('validateStoredMintWindow');
    expect(entry).to.include('universal/prefixed_integers.js');
    expect(entry).to.include('**Direction: TIGHTENING, ungated.**');
}

// The BATCH probe's per-leg SEND fold re-pins send and batch and holds the anchor.
function batchLegFoldReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    expect(rows.find((r) => r.handler === 'src/actions/send/').hash)
        .to.equal('3e4d1e274403cac24057c65453cf2168f5fc761fe15bf6f048aa01cf5a73cdc8');
    const heading = '### 2026-11-14 - a BATCH probe answers a multi-leg SEND sub-command with its first refused leg';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    expect(entry).to.include('The `send` pin moves from `1591aa81` to `341e2755`');
    expect(entry).to.include('the `batch` pin moves from `9a5147d0` to `c6ca292c`');
    expect(entry).to.include('foldLegVerdicts');
    expect(entry).to.include('NO CLIENT CHECK MOVES');
    expect(entry).to.include('**Direction: NEUTRAL for validity.**');
}

// The BATCH probe's DISPENSE note re-pins batch and moves the anchor to the origin develop head.
function batchDispenseNoteReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/batch/').hash).to.equal(BATCH_PIN);
    const heading = '### 2026-11-15 - a BATCH probe says why it cannot judge a payment-triggered DISPENSE';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    expect(entry).to.include('The `batch` pin moves from `c6ca292c` to `ca3e05eb`');
    expect(text).to.include('(Re-anchored 2026-11-16 to `93cde565f`');
    expect(entry).to.include('NO CLIENT CHECK MOVES');
    expect(entry).to.include('**Direction: NEUTRAL for validity.**');
}

// The ORDER GET_ADDRESS coin gate re-pins order and moves the anchor to the indexer branch tip.
function orderGetAddressCoinReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    expect(parseMap(REAL_MAP).find((r) => r.handler === 'src/actions/order/').hash)
        .to.equal('faa64e31b2a882a6f337db72069b5b5bb8e0ef253f8a15916d5c1626b5d1088b');
    const heading = '### 2026-11-16 - a cross-chain ORDER\'s GET_ADDRESS is judged against GET_COIN behind '
        + 'ORDER_GET_ADDRESS_COIN';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    expect(entry).to.include('The `order` pin moves from `86b0a7c3` to `4e130541`');
    expect(text).to.include('(Re-anchored 2026-11-16 to `a6b8655f2`');
    expect(entry).to.include('checkOrderGetAddressCoin');
    expect(entry).to.include('STATE_VALUE_ASTRAL_ESCAPE');
    expect(entry).to.include('LINT_REGEX_GROUP_DEPTH');
    expect(entry).to.include('**Direction: TIGHTENS for a cross-chain ORDER whose GET_ADDRESS is not GET_COIN\'s');
}

// The review round re-pins send, destroy, dispenser and airdrop, adds the AIRDROP leg parse
// refusal and moves the anchor to the indexer branch tip.
function airdropLegParseReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    const pins = {
        'src/actions/send/': '3e4d1e274403cac24057c65453cf2168f5fc761fe15bf6f048aa01cf5a73cdc8',
        'src/actions/destroy/': 'a52180e45cacbbb02ee302391bbff6c95eecdee68d6e62b8da97bc25eeb9b348',
        'src/actions/dispenser/': '65209162a134ea9d067ccff5e0ed5127bdc3397ec72ff9efde2ef7cb86542a3a',
        'src/actions/airdrop/': '188c409ef4027a2291657c4db6050f72c3921bd0ae43f01d7ea03dfc6f7d7ace',
    };
    for (const [handler, hash] of Object.entries(pins))
        expect(rows.find((r) => r.handler === handler).hash, handler).to.equal(hash);
    const heading = '### 2026-11-18 - AIRDROP refuses a leg amount the ledger cannot parse, and DESTROY and '
        + 'AIRDROP keep per-leg probe verdicts';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    expect(entry).to.include('The `send` pin moves from `341e2755` to `d5063639`');
    expect(entry).to.include('the `airdrop` pin moves from `9b3ade3b` to `a7083540`');
    expect(text).to.include('(Re-anchored 2026-11-18 to `6257fff51`');
    expect(entry).to.include('checkAmountParses');
    expect(entry).to.include('**Direction: TIGHTENS AIRDROP, ungated.**');
}

// Every guard-gas settle path calls one billing helper and BATCH probe collectors key on
// DRY_RUN, so twelve rows re-pin with no client check moving.
function guardGasBillingReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    const pins = {
        'src/actions/send/': '3e4d1e274403cac24057c65453cf2168f5fc761fe15bf6f048aa01cf5a73cdc8',
        'src/actions/destroy/': 'a52180e45cacbbb02ee302391bbff6c95eecdee68d6e62b8da97bc25eeb9b348',
        'src/actions/mint/': '8321748e950c0ee3e0b2fdd3a73105e920c6f37714912d97847024841a918e53',
        'src/actions/dispenser/': '65209162a134ea9d067ccff5e0ed5127bdc3397ec72ff9efde2ef7cb86542a3a',
        'src/actions/order/': 'faa64e31b2a882a6f337db72069b5b5bb8e0ef253f8a15916d5c1626b5d1088b',
        'src/actions/swap/': '93af1143be284be5bd2007ab4b8f0df509065ece59367bcbd737648d7134939e',
        'src/actions/airdrop/': '188c409ef4027a2291657c4db6050f72c3921bd0ae43f01d7ea03dfc6f7d7ace',
        'src/actions/dividend/': '6f30915832b6c50d037914f9a0bd58f9d9ab72cc4ea926fd27aec114a99b094c',
        'src/actions/batch/': BATCH_PIN,
        'src/actions/deposit.js': '2d8585841185d9948b841eb078f55c843ea6df0801206c6778005a51bf4bcf31',
        'src/actions/withdraw.js': 'cb8b7bf31b80689ec2c7c53139082b7123f2c9af97becfbb64eb0cf3eb3671af',
        'src/actions/stake/': '791da27d6f8a49fc3498344b8a6bc4044bf9bdf4ff5811d88c9503077845e025',
    };
    for (const [handler, hash] of Object.entries(pins))
        expect(rows.find((r) => r.handler === handler).hash, handler).to.equal(hash);
    const heading = '### 2026-11-18 - guard gas is billed through one helper and BATCH probe collectors key on DRY_RUN';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    expect(entry).to.include('the `batch` pin moves from `ca3e05eb` to `cb526c2f`');
    expect(entry).to.include('billGuardGas');
    expect(text).to.include('(Re-anchored 2026-11-18 to `33fbabce2`');
    expect(text).to.include('(Re-anchored 2026-11-18 to `33fbabce2`');
    expect(entry).to.include('NO CLIENT CHECK MOVES');
    expect(entry).to.include('**Direction: NEUTRAL for validity.**');
}

// A skipped COINPAY sub-command in an authenticated dry-run reports null, so only the batch pin
// moves and the anchor stays on origin develop.
function coinpayDryRunStatusReview() {
    const text = fs.readFileSync(REAL_MAP, 'utf8');
    const rows = parseMap(REAL_MAP);
    expect(rows.find((r) => r.handler === 'src/actions/batch/').hash).to.equal(BATCH_PIN);
    const heading = '### 2026-11-19 - an authenticated BATCH dry-run reports a skipped COINPAY sub-command as unjudged';
    expect(text).to.include(heading);
    const entry = entryOf(text, heading).replace(/\s+/g, ' ');
    expect(entry).to.include('The `batch` pin moves from `cb526c2f` to `1c42ba29`');
    expect(entry).to.include('`a11e0d7be`');
    expect(text).to.include('(Re-anchored 2026-11-18 to `33fbabce2`');
    expect(text).to.include('(Not re-anchored 2026-11-19.');
    expect(entry).to.include('NO CLIENT CHECK MOVES');
    expect(entry).to.include('**Direction: NEUTRAL for validity.**');
}

describe('pre-flight constants + registry drift map (§8.5) gate retirement reviews', function () {
    it('pins and records the authenticated BATCH dry-run COINPAY status review', coinpayDryRunStatusReview);
    it('pins and records the guard gas billing helper and BATCH dry-run collector review', guardGasBillingReview);
    it('pins and records the AIRDROP leg amount parse refusal review', airdropLegParseReview);
    it('pins and records the ORDER GET_ADDRESS coin gate review', orderGetAddressCoinReview);
    it('pins and records the BATCH probe DISPENSE unjudged note review', batchDispenseNoteReview);
    it('pins and records the BATCH probe multi-leg SEND fold review', batchLegFoldReview);
    it('pins and records the ISSUE prefixed mint window review', mintWindowReview);
    it('pins and records the ISSUE, DISPENSER, ORDER, SWAP and BET prefixed integer review', prefixedIntegerReview);
    it('pins and records the ISSUE, PRICE v1 and BET column-width review', columnWidthReview);
    it('pins and records the DISPENSER and DISPENSE amount positivity gate retirement review', dispenserPositivityReview);
    it('the live dispenser pin is the end of the review-log pin chain', dispenserPinChainEnd);
    it('pins and records the AIRDROP native fee tally gate review', airdropFeeTallyReview);
    it('pins and records the SEND gated handoff reference gate retirement review', sendHandoffRetirementReview);
    it('pins and records the BATCH probe sub-verdict match snapshot review', batchSnapshotReviews);
    it('pins and records the SEND, DESTROY and MINT gas balance read review', gasBalanceReadReview);
    it('pins and records the AIRDROP zero leg, DIVIDEND empty allow list and equal-price ORDER reviews', october23GatesReview);
    it('pins and records the SEND, DESTROY and STAKE NOT NULL amount width review', notNullAmountWidthReview);
    it('pins and records the ISSUE caret TICK canonical id review', tickNormalizeReview);
    it('pins and records the ORDER and SWAP same-token offer refusal review', sameTokenOfferReview);
});
