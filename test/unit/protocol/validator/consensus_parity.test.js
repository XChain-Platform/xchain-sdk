'use strict';

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * Compose-time verdicts that must match the indexer's on the same wire
 * string: free-text caps counted in UTF-16 code units, well-formed text,
 * the compiled size ceiling, VOTE v0 poll rules, the stateless amount and
 * integer rules, and which refusals are user-protection guards rather than
 * consensus rules. Each case names the indexer verdict it mirrors.
 *
 ********************************************************************/

const { expect } = require('chai');
const config  = require('../../../../src/config.js');
const Utility = require('../../../../src/utils/utility.js');
const Actions = require('../../../../src/actions/index.js');
const { MAX_ACTION_DATA_LENGTH } = require('../../../../src/contract/chunk_helper.js');

const A1 = 'mtr6NtB5KJRAxTX5AbuRtV7S4FF2PZJXUs';
const A2 = 'mjrCrhL4qjKo1oGYJb78Lp8GoBiF6yFTZM';
const PUB = 'ab'.repeat(32);
const EMOJI = '\u{1F600}';

function actions(network) {
    return new Actions({ config: config.getConfig(), util: new Utility(), options: { network: network || 'bitcoin-regtest' } });
}

// The thrown error, or null when the action composes. `request` may name an
// encoder and a network.
function composeError(action, params, request) {
    const extra = request || {};
    try {
        actions(extra.network).composeActionString({ action, params, encoder: extra.encoder });
        return null;
    } catch (e) {
        return e;
    }
}

const composes = (action, params, request) => composeError(action, params, request) === null;

describe('compose verdicts match the indexer: free-text caps', function () {
    const send = (memo) => ({ VERSION: '0', TICK: 'TEST', AMOUNT: '1', DESTINATION: A1, MEMO: memo });

    it('MEMO is capped at 250 UTF-16 code units, not bytes or characters', function () {
        expect(composes('SEND', send('a'.repeat(250)))).to.equal(true);
        expect(composes('SEND', send('a'.repeat(251)))).to.equal(false);   // invalid: MEMO (length)
        expect(composes('SEND', send('é'.repeat(250)))).to.equal(true); // 500 bytes, 250 units
        expect(composes('SEND', send(EMOJI.repeat(125)))).to.equal(true);  // 250 units
        expect(composes('SEND', send(EMOJI.repeat(126)))).to.equal(false); // 126 characters, 252 units
    });

    it('PRICE v1 keeps MEMO unchecked and VOTE bounds it by the message ceiling', function () {
        expect(composes('PRICE', { VERSION: '1', COIN: 'BTC', TICK: 'TEST', FIAT: 'USD', VALUE: '1.5', MEMO: 'a'.repeat(251) })).to.equal(true);
        expect(composes('VOTE', { VERSION: '1', POLL_REF: '5', BALLOT: '1', MEMO: 'a'.repeat(251) })).to.equal(true);
    });

    it('a per-leg MEMO is capped too, since the indexer refuses that leg', function () {
        const legs = [{ TICK: 'TEST', AMOUNT: '1', DESTINATION: A1, MEMO: 'a'.repeat(251) },
            { TICK: 'GAS', AMOUNT: '2', DESTINATION: A2, MEMO: 'm' }];
        expect(composes('SEND', { VERSION: '3', LEGS: legs })).to.equal(false);
    });

    it('BROADCAST MESSAGE, FILE NAME and FILE TITLE are capped at 250', function () {
        expect(composes('BROADCAST', { VERSION: '0', MESSAGE: 'a'.repeat(250), VALUE: '1' })).to.equal(true);
        expect(composes('BROADCAST', { VERSION: '0', MESSAGE: 'a'.repeat(251), VALUE: '1' })).to.equal(false);
        expect(composes('FILE', { VERSION: '0', NAME: 'a'.repeat(251), TYPE: 'text/plain' })).to.equal(false);
        expect(composes('FILE', { VERSION: '0', NAME: 'f.txt', TYPE: 'text/plain', TITLE: 'a'.repeat(251) })).to.equal(false);
    });

    it('ISSUE DESCRIPTION is refused at 250, as the indexer refuses it', function () {
        expect(composes('ISSUE', { VERSION: '1', TICK: 'TEST', DESCRIPTION: 'a'.repeat(249) })).to.equal(true);
        expect(composes('ISSUE', { VERSION: '1', TICK: 'TEST', DESCRIPTION: 'a'.repeat(250) })).to.equal(false);
    });

    it('an unpaired surrogate is refused in every free-text field', function () {
        expect(composes('SEND', send('a\uD800b'))).to.equal(false);
        expect(composes('ISSUE', { VERSION: '1', TICK: 'TEST', DESCRIPTION: 'a\uDC00b' })).to.equal(false);
        expect(composes('BROADCAST', { VERSION: '0', MESSAGE: 'a\uD800', VALUE: '1' })).to.equal(false);
        expect(composes('SEND', send('a\u{1F600}b'))).to.equal(true);
    });
});

describe('compose verdicts match the indexer: size ceiling', function () {
    const message = (bytes) => {
        const head = 'MESSAGE|3|BTC|' + A1 + '|';
        return { VERSION: '3', COIN: 'BTC', DESTINATION: A1, PLAINTEXT_MESSAGE: 'a'.repeat(bytes - head.length) };
    };

    const tooLarge = (bytes, request) => {
        const e = composeError('MESSAGE', message(bytes), request);
        return e === null ? false : e.code === 'ACTION_TOO_LARGE' ? true : e.code;
    };

    it('measures the compiled push when the caller chose a legacy carrier', function () {
        for (const encoding of ['OP_RETURN', 'P2SH', 'P2WSH', 'MULTISIGN']) {
            const encoder = { encoding };
            if (encoding !== 'OP_RETURN') expect(tooLarge(MAX_ACTION_DATA_LENGTH - 3, { encoder }), encoding).to.equal(false);
            expect(tooLarge(MAX_ACTION_DATA_LENGTH - 2, { encoder }), encoding).to.equal(true);
            expect(tooLarge(MAX_ACTION_DATA_LENGTH, { encoder }), encoding).to.equal(true);
        }
    });

    it('treats AUTO without a tapscript signer, and a chain with no Taproot, as legacy', function () {
        expect(tooLarge(MAX_ACTION_DATA_LENGTH, { encoder: { encoding: 'AUTO' } })).to.equal(true);
        expect(tooLarge(MAX_ACTION_DATA_LENGTH, { network: 'dogecoin-regtest' })).to.equal(true);
    });

    it('never applies the legacy cap to the Taproot envelope or an undecided carrier', function () {
        const big = 20000;
        expect(tooLarge(big, { encoder: { encoding: 'TAPROOT' } })).to.equal(false);
        expect(tooLarge(big, { encoder: { encoding: 'AUTO', options: { signerSupportsTapscript: true } } })).to.equal(false);
        expect(tooLarge(big)).to.equal(false);
    });

    it('caps the envelope at ENVELOPE_MAX_PAYLOAD', function () {
        const { ENVELOPE_MAX_PAYLOAD } = require('../../../../src/protocol/constants.js');
        expect(tooLarge(ENVELOPE_MAX_PAYLOAD - 5, { encoder: { encoding: 'TAPROOT' } })).to.equal(false);
        expect(tooLarge(ENVELOPE_MAX_PAYLOAD - 4, { encoder: { encoding: 'TAPROOT' } })).to.equal(true);
    });

    it('composes a 300-item LIST and an 18.7 KB DEPLOY when no carrier is chosen', function () {
        const items = Array.from({ length: 300 }, (_, i) => 'TICK' + i);
        expect(composeError('LIST', { VERSION: '4', TYPE: '1', NAME: 'n', DESCRIPTION: 'd', ITEM: items })).to.equal(null);
        const code = 'export function main(){ return 1; }\n' + '// pad\n'.repeat(2000);
        expect(composeError('DEPLOY', { VERSION: '0', CODE: code, GAS_LIMIT: '100000' })).to.equal(null);
    });

    it('leaves the ceiling to the caller when validation is off', function () {
        const r = actions().composeActionString({ action: 'MESSAGE', params: message(MAX_ACTION_DATA_LENGTH) }, { validate: false });
        expect(Buffer.byteLength(r.actionString)).to.equal(MAX_ACTION_DATA_LENGTH);
    });
});

describe('compose verdicts match the indexer: VOTE v0', function () {
    const poll = (over) => Object.assign({ VERSION: '0', TICK: 'TEST', END_BLOCK: '5000', OPTIONS: 'A,B',
        MAX_SELECTIONS: '1', TALLY_MODE: 'approval', WEIGHT_MODE: 'balance', QUORUM: '0.5', DECIDE_THRESHOLD: '0.6' }, over);

    it('accepts a well-formed poll', function () {
        expect(composes('VOTE', poll({}))).to.equal(true);
    });

    for (const [label, over] of [
        ['TALLY_MODE is case-sensitive', { TALLY_MODE: 'Approval' }],
        ['WEIGHT_MODE stake is reserved', { WEIGHT_MODE: 'stake' }],
        ['DECIDE_THRESHOLD 0 is outside (0, 1]', { DECIDE_THRESHOLD: '0' }],
        ['QUORUM above 1', { QUORUM: '1.5' }],
        ['fewer than two OPTIONS', { OPTIONS: 'A,' }],
        ['MAX_SELECTIONS above the option count', { MAX_SELECTIONS: '3' }],
        ['quadratic weight with no MIN_VOTE_BALANCE floor', { WEIGHT_MODE: 'quadratic', MIN_VOTE_BALANCE: '0' }],
        ['a binding poll with no CALLBACK_METHOD', { CALLBACK_CONTRACT: '7' }],
        ['GAS_ESCROW without CALLBACK_CONTRACT', { GAS_ESCROW: '5' }],
        ['a non-numeric END_BLOCK', { END_BLOCK: 'soon' }],
    ]) {
        it('refuses ' + label, function () {
            expect(composes('VOTE', poll(over))).to.equal(false);
        });
    }

    it('accepts quadratic weight once MIN_VOTE_BALANCE is above zero', function () {
        expect(composes('VOTE', poll({ WEIGHT_MODE: 'quadratic', MIN_VOTE_BALANCE: '1' }))).to.equal(true);
    });
});

describe('compose verdicts match the indexer: stateless amount and integer rules', function () {
    const price  = { VERSION: '1', COIN: 'BTC', TICK: 'TEST', FIAT: 'USD', VALUE: '1.5' };
    const order  = { VERSION: '0', GIVE_TICK: 'TEST', GIVE_AMOUNT: '1', GET_TICK: 'GAS', GET_AMOUNT: '1', EXPIRATION: '1800000000' };
    const disp   = { VERSION: '0', GIVE_TICK: 'TEST', GIVE_AMOUNT: '1', GET_TICK: 'GAS', GET_AMOUNT: '1' };
    const deploy = { VERSION: '1', CODE_ENCODING: 'YQ==', GAS_LIMIT: '100000', CONSTRUCTOR_PARAMS: ['a'], COOLDOWN_BLOCKS: '10' };
    const file   = { VERSION: '0', NAME: 'f.txt', TYPE: 'text/plain' };
    const send   = { VERSION: '0', TICK: 'TEST', AMOUNT: '1', DESTINATION: A1 };

    // [what the indexer refuses, action, a base that composes, the one change]
    for (const [label, action, base, bad] of [
        ['PRICE v1 VALUE longer than 19 characters', 'PRICE', price, { VALUE: '1000000000000000000000' }],
        ['PRICE v1 VALUE at or above the hub ceiling', 'PRICE', price, { VALUE: '9007199254740993' }],
        ['PRICE v1 TICK longer than 250', 'PRICE', price, { TICK: 'T'.repeat(251) }],
        ['BROADCAST VALUE longer than 25', 'BROADCAST', { VERSION: '0', MESSAGE: 'm', VALUE: '1' }, { VALUE: '123456789.123456789012345678' }],
        ['a fractional DEPLOY COOLDOWN_BLOCKS', 'DEPLOY', deploy, { COOLDOWN_BLOCKS: '1.5' }],
        ['a fractional EXPIRATION', 'ORDER', order, { EXPIRATION: '1800000000.5' }],
        ['FIAT_AMOUNT with no FIAT_CODE', 'DISPENSER', disp, { FIAT_AMOUNT: '1' }],
        ['GATE_MIN_AMOUNT with no GATE_TICKER', 'FILE', file, { GATE_MIN_AMOUNT: '1' }],
        ['REQUIRE_MEMO outside 0/1', 'ADDRESS', { VERSION: '0', FEE_PREFERENCE: '1', REQUIRE_MEMO: '1' }, { REQUIRE_MEMO: '2' }],
        ['a negative ISSUE MAX_MINT', 'ISSUE', { VERSION: '2', TICK: 'TEST', MAX_MINT: '1' }, { MAX_MINT: '-1' }],
        ['a negative ISSUE MINT_SUPPLY', 'ISSUE', { VERSION: '2', TICK: 'TEST', MINT_SUPPLY: '1' }, { MINT_SUPPLY: '-1' }],
        ['an AMOUNT with 19 fractional digits', 'SEND', send, { AMOUNT: '0.0000000000000000001' }],
        ['a capability STAKE AMOUNT with 9 decimals', 'STAKE', { VERSION: '1', AMOUNT: '0.00000001', SIGNING_PUBKEY: PUB }, { AMOUNT: '0.000000001' }],
    ]) {
        it('refuses ' + label, function () {
            expect(composeError(action, Object.assign({}, base)), 'the base composes').to.equal(null);
            expect(composes(action, Object.assign({}, base, bad))).to.equal(false);
        });
    }

    it('still accepts the in-range neighbours of those values', function () {
        expect(composes('PRICE', Object.assign({}, price, { VALUE: '9999999999.5' }))).to.equal(true);
        expect(composes('BROADCAST', { VERSION: '0', MESSAGE: 'm', VALUE: '0.0000000000000000001' })).to.equal(true);
        expect(composes('SEND', Object.assign({}, send, { AMOUNT: '0.000000000000000001' }))).to.equal(true);
    });
});

describe('compose verdicts match the indexer: ISSUE orderings and XBRIDGE shape', function () {
    const issue2 = { VERSION: '2', TICK: 'TEST', MAX_MINT: '10', MINT_SUPPLY: '5', MINT_ADDRESS_MAX: '10',
        MINT_START_BLOCK: '200', MINT_STOP_BLOCK: '5000' };
    const issue0 = Object.assign({}, issue2, { VERSION: '0', MAX_SUPPLY: '1000', DECIMALS: '0' });

    for (const [label, base, bad] of [
        ['MINT_SUPPLY above a positive MAX_SUPPLY', issue0, { MINT_SUPPLY: '1001' }],
        ['MINT_ADDRESS_MAX above a positive MAX_SUPPLY', issue0, { MINT_ADDRESS_MAX: '1001', MAX_MINT: '10' }],
        ['MINT_ADDRESS_MAX below MAX_MINT', issue2, { MAX_MINT: '11' }],
        ['MINT_STOP_BLOCK before MINT_START_BLOCK', issue2, { MINT_START_BLOCK: '6000' }],
    ]) {
        it('refuses ' + label, function () {
            expect(composeError('ISSUE', Object.assign({}, base)), 'the base composes').to.equal(null);
            expect(composes('ISSUE', Object.assign({}, base, bad))).to.equal(false);
        });
    }

    it('leaves a comparison alone when one side is inherited from the token row', function () {
        expect(composes('ISSUE', { VERSION: '2', TICK: 'TEST', MINT_SUPPLY: '1000000' })).to.equal(true);
        expect(composes('ISSUE', Object.assign({}, issue0, { MAX_SUPPLY: '0', MINT_SUPPLY: '5' }))).to.equal(true);
    });

    it('refuses a fractional mint block as a guard, not a chain rule', function () {
        const e = composeError('ISSUE', Object.assign({}, issue2, { MINT_START_BLOCK: '200.5' }));
        expect(e && e.details.errors.map(x => x.details.sdkGuard)).to.deep.equal([true]);
    });

    for (const [label, network, params] of [
        ['XBRIDGE v1 on BTC', 'bitcoin-regtest', { VERSION: '1', BTC_ADDRESS: A1, AMOUNT: '1' }],
        ['XBRIDGE v0 off BTC', 'litecoin-regtest', { VERSION: '0', DEST_COIN: 'BTC', DEST_ADDRESS: A1, AMOUNT: '1' }],
        ['XBRIDGE v3 of a subasset', 'bitcoin-regtest', { VERSION: '3', TICK: 'TEST.CHILD', DEST_COIN: 'LTC', DEST_ADDRESS: A1, AMOUNT: '1' }],
        ['XBRIDGE v3 of a tick too long to root', 'bitcoin-regtest', { VERSION: '3', TICK: 'T'.repeat(247), DEST_COIN: 'LTC', DEST_ADDRESS: A1, AMOUNT: '1' }],
        ['XBRIDGE v4 of a tick that is no bridged copy here', 'bitcoin-regtest', { VERSION: '4', TICK: 'BTC.TEST', ORIGIN_ADDRESS: A1, AMOUNT: '1' }],
    ]) {
        it('refuses ' + label, function () {
            expect(composes('XBRIDGE', params, { network })).to.equal(false);
        });
    }

    it('accepts the XBRIDGE shapes the chain accepts', function () {
        expect(composes('XBRIDGE', { VERSION: '3', TICK: 'T'.repeat(246), DEST_COIN: 'LTC', DEST_ADDRESS: A1, AMOUNT: '1' })).to.equal(true);
        expect(composes('XBRIDGE', { VERSION: '4', TICK: 'LTC.TEST', ORIGIN_ADDRESS: A1, AMOUNT: '1' })).to.equal(true);
        expect(composes('XBRIDGE', { VERSION: '0', DEST_COIN: 'LTC', DEST_ADDRESS: A1, AMOUNT: '1' })).to.equal(true);
    });
});

describe('compose: user-protection guards against what the chain accepts', function () {
    it('keeps refusing a zero SEND, tagging the finding as a guard', function () {
        const e = composeError('SEND', { VERSION: '0', TICK: 'TEST', AMOUNT: '0', DESTINATION: A1 });
        expect(e && e.details.errors[0].details.sdkGuard).to.equal(true);
    });

    it('keeps a zero STAKE a consensus finding, since the chain refuses it too', function () {
        const e = composeError('STAKE', { VERSION: '1', AMOUNT: '0', SIGNING_PUBKEY: PUB });
        expect(e && e.details.errors[0].details.sdkGuard).to.equal(undefined);
    });

    it('accepts a FILE with no NAME and a BROADCAST with no MESSAGE, as the chain does', function () {
        expect(composes('FILE', { VERSION: '0', TYPE: 'text/plain', TITLE: 't' })).to.equal(true);
        expect(composes('BROADCAST', { VERSION: '0', VALUE: '1' })).to.equal(true);
    });

    it('refuses a BROADCAST that carries nothing at all, as a guard', function () {
        const e = composeError('BROADCAST', { VERSION: '2' });
        expect(e && e.details.errors[0].details.sdkGuard).to.equal(true);
    });
});
