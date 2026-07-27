'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// decoder.describe unit suite: dedicated describers stay non-generic,
// legacy {action, params} inputs keep working (wallet shim path),
// ParsedAction BATCH commands render per-command, extended ctx
// (ownAddresses/contacts) marks destinations, and the §3.5 hardening
// pass covers every describer by construction.

const { expect } = require('chai');
const { parse } = require('../../../src/decoder/parse.js');
const { describe: describeAction } = require('../../../src/decoder/describe.js');
const FORMATS = require('../../../src/formats.js');

const GENERIC = /No plain-English summary is available/;

describe('decoder.describe', function () {

    it('SEND from a ParsedAction', function () {
        const d = describeAction(parse('SEND|0|JDOG|1.5|bc1qabc|hi'));
        expect(d.summary).to.equal('Send 1.5 JDOG to bc1qabc');
        expect(d.details.map(x => x.label)).to.deep.equal(['Token', 'Amount', 'Destination', 'Memo']);
        expect(d.warnings).to.deep.equal([]);
    });

    it('legacy {action, params} shape still works (wallet shim path)', function () {
        const d = describeAction({ action: 'SEND', params: { TICK: 'JDOG', AMOUNT: '2', DESTINATION: 'x', MEMO: '' } });
        expect(d.summary).to.equal('Send 2 JDOG to x');
    });

    it('createAction-style {action, fields} shape accepted', function () {
        const d = describeAction({ action: 'MINT', fields: { TICK: 'JDOG', AMOUNT: '5' } });
        expect(d.summary).to.match(/^Mint 5 JDOG/);
    });

    it('chainRegistry ctx adds the chain suffix', function () {
        const registry = { get: () => ({ displayName: 'Bitcoin' }) };
        const d = describeAction(parse('SEND|0|JDOG|1|a'), { chainId: 'btc', chainRegistry: registry });
        expect(d.summary).to.include(' on Bitcoin ');
    });

    describe('dedicated describers are non-generic', function () {
        const cases = {
            'SEND|0|JDOG|1|a|m': /Send/,
            'SWEEP|0|dest': /^Sweep /,
            'ISSUE|0|TOK|1000': /^Create token TOK/,
            'ISSUE|1|TOK|new desc': /^Update description/,
            'ISSUE|6|TOK|42|SEND|10|0': /controller/i,
            'MINT|0|JDOG|5': /^Mint /,
            'DESTROY|0|JDOG|5': /^Destroy /,
            'BROADCAST|0|hello': /^Broadcast /,
            'DISPENSER|1|33': /^Cancel dispenser/,
            'DIVIDEND|0|JDOG|GAS|1': /^Pay /,
            'LIST|0|2|a1|a2': /^Create address list/,
            'AIRDROP|0|JDOG|1|55': /^Airdrop /,
            'ORDER|0|BTC|GIVE|10|0|BTC|GET|5|0': /^Create order/,
            'ORDER|1|42': /^Cancel order/,
            'SWAP|0|BTC|GIVE|10|0|BTC|GET|5|0': /^Create swap/,
            'STAKE|1|100|aabb': /^Stake 100/,
            'UNSTAKE|0|aabb': /^Unstake/,
            'DELEGATE|0|aabb': /Rotate validator signing key/,
            'DELEGATE|2|aabb': /Revoke validator signing key/,
            'VOTE|1|55|2|note': /^Cast ballot/,
            'VOTE|3|JDOG|addr9': /^Delegate JDOG voting power/,
            'DEPLOY|0|aGVsbG8=|100000': /^Deploy smart contract/,
            'DEPLOY|4|deadbeef|1|4|QUJD': /chunk 1 of 4/,
            'EXECUTE|0|9|mint|alice': /^Call mint\(\) on contract #9/,
            'DEPOSIT|0|7|JDOG|100': /^Deposit 100 JDOG into contract #7/,
            'WITHDRAW|0|7|JDOG|100': /^Withdraw 100 JDOG from contract #7/,
            'COINPAY|0|42': /settle order match #42/,
            'COLLECT|0': /^Collect validator rewards/,
            'MESSAGE|3|BTC|addr|hello': /^Send public message/,
            'FILE|0|doc.txt|text/plain': /^Publish file doc.txt/,
            'LINK|0|BTC|1|DOGE|2': /^Link BTC action #1 to DOGE action #2/,
            'SLEEP|0|900000|JDOG': /until block 900000/,
            'CALLBACK|0|JDOG': /callback redemption of JDOG/,
            'PRICE|1|BTC|JDOG|USD|1.5': /^Publish oracle price 1 JDOG = 1.5 USD/,
            'BET|0|Rain tomorrow|yes,no|JDOG|0.02|900000|86400': /^Open a betting market on JDOG/,
            'BET|1|42': /^Cancel market 42 and refund every bet/,
            'BET|2|42|1|10': /^Bet 10 on outcome 1 of market 42/,
            'BET|3|42|1': /^Resolve market 42 to outcome 1/,
        };
        for (const [wire, re] of Object.entries(cases)) {
            it(wire.split('|').slice(0, 2).join(' v'), function () {
                const parsed = parse(wire);
                expect(parsed.ok, wire).to.equal(true);
                const d = describeAction(parsed);
                expect(d.summary).to.match(re);
                expect(d.warnings.join('\n')).to.not.match(GENERIC);
            });
        }
    });

    // : BET and PRICE were promoted from the wallet's local
    // describer, which had moved ahead of this one. What makes them worth
    // having is not the summary line but the irreversibilities they state,
    // so those are pinned per format rather than left to a shape assertion.
    describe('BET ( §11.3)', function () {
        it('a placed bet states finality and the parimutuel share', function () {
            const w = describeAction(parse('BET|2|42|1|10')).warnings.join('\n');
            expect(w).to.include('Bets are final');
            expect(w).to.include('parimutuel');
        });

        it('a resolve states that it is the payout decision, and final', function () {
            const w = describeAction(parse('BET|3|42|1')).warnings.join('\n');
            expect(w).to.include('splits the pot');
            expect(w).to.include('cannot be undone');
        });

        it('a cancel states that every bet is refunded', function () {
            expect(describeAction(parse('BET|1|42')).warnings.join('\n')).to.include('refunded in full');
        });

        it('market creation names the signer as the oracle', function () {
            const d = describeAction(parse('BET|0|Rain tomorrow|yes,no|JDOG|0.02|900000|86400'));
            expect(d.warnings.join('\n')).to.include('You are the oracle');
            expect(d.details.find(x => x.label === 'Outcomes').value).to.equal('yes / no');
        });

        it('a single-outcome market is flagged', function () {
            const d = describeAction(parse('BET|0|Rain tomorrow|yes|JDOG|0.02|900000|86400'));
            expect(d.warnings.join('\n')).to.include('at least two outcomes');
        });

        it('the builder\'s camelCase output describes identically to the wire form', function () {
            const camel = describeAction({ action: 'BET', params: { version: '2', feedActionIndex: '42', outcome: '1', amount: '10' } });
            expect(camel.summary).to.equal(describeAction(parse('BET|2|42|1|10')).summary);
        });
    });

    describe('PRICE (PC-30)', function () {
        it('v1 states the 24h delay and the dispenser consequence', function () {
            const w = describeAction(parse('PRICE|1|BTC|JDOG|USD|1.5')).warnings.join('\n');
            expect(w).to.include('24 hours');
            expect(w).to.include('Dispensers that name this address');
        });

        it('the wire FEE fraction is shown as both fraction and percent', function () {
            const d = describeAction(parse('PRICE|1|BTC|JDOG|USD|1.5|0.02'));
            expect(d.details.find(x => x.label === 'Oracle usage fee').value).to.equal('0.02 (2% of a dispenser\'s projected proceeds)');
        });

        it('a fee above 1 is called out as a rejection, not a percentage', function () {
            const d = describeAction(parse('PRICE|1|BTC|JDOG|USD|1.5|2'));
            expect(d.warnings.join('\n')).to.include('above 1 (100%)');
        });

        it('v0 is flagged as federation-only rather than summarized as signable', function () {
            const d = describeAction(parse('PRICE|1|BTC|JDOG|USD|1.5'), {});
            expect(d.summary).to.not.include('Validator price snapshot');
            const v0 = describeAction({ action: 'PRICE', params: { VERSION: '0', COIN: 'BTC', FIAT: 'USD', VALUE: '1.5' } });
            expect(v0.summary).to.match(/^Validator price snapshot/);
            expect(v0.warnings.join('\n')).to.include('will reject this transaction');
        });

        it('the price row carries no currency suffix (the hardening pass amount-checks it)', function () {
            const d = describeAction(parse('PRICE|1|BTC|JDOG|USD|1.5'));
            expect(d.details.find(x => x.label === 'Price per unit').value).to.equal('1.5');
            expect(d.warnings.join('\n')).to.not.match(/not a plain decimal/);
        });
    });

    it('unknown-to-describe actions get the generic fallback with all params listed', function () {
        // ADDRESS v0 is the one remaining format without a dedicated
        // describer; unknown future actions take the same path.
        const d = describeAction({ action: 'FUTURE_ACTION', params: { SOME_FIELD: 'x' } });
        expect(d.warnings.join(' ')).to.match(GENERIC);
        expect(d.details.map(x => x.label)).to.include('Some field');
    });

    describe('BATCH', function () {
        it('renders each parsed command and the non-atomicity warning', function () {
            const d = describeAction(parse('BATCH|0|MINT|0|JDOG|5;SEND|0|JDOG|5|addr'));
            expect(d.summary).to.match(/^Batch of 2 actions/);
            expect(d.summary).to.include('1. Mint 5 JDOG');
            expect(d.summary).to.include('2. Send 5 JDOG to addr');
            expect(d.warnings.join(' ')).to.include('NOT atomic');
        });

        it('a failed sub-parse renders explicitly without hiding the rest', function () {
            const d = describeAction(parse('BATCH|0|NOPE|0|x;MINT|0|JDOG|5'));
            expect(d.summary).to.include('Command 1 could not be decoded (UNKNOWN_ACTION)');
            expect(d.summary).to.include('2. Mint 5 JDOG');
        });

        it('legacy COMMANDS array shape still renders', function () {
            const d = describeAction({
                action: 'BATCH',
                params: { COMMANDS: [{ action: 'MINT', params: { TICK: 'A', AMOUNT: '1' } }] },
            });
            expect(d.summary).to.match(/^Batch of 1 action/);
        });
    });

    describe('extended ctx', function () {
        it('ownAddresses marks a self-send destination', function () {
            const d = describeAction(parse('SEND|0|JDOG|1|myaddr1'), { ownAddresses: ['myaddr1'] });
            const dest = d.details.find(x => x.label === 'Destination');
            expect(dest.value).to.equal('myaddr1 (your address)');
        });

        it('contacts marks a known destination', function () {
            const d = describeAction(parse('SEND|0|JDOG|1|bobaddr'), { contacts: { bobaddr: 'Bob' } });
            const dest = d.details.find(x => x.label === 'Destination');
            expect(dest.value).to.equal('bobaddr (contact: Bob)');
        });

        it('both absent: values untouched (graceful degradation)', function () {
            const d = describeAction(parse('SEND|0|JDOG|1|bobaddr'));
            expect(d.details.find(x => x.label === 'Destination').value).to.equal('bobaddr');
        });

        it('tokenDecimals enables precision verification', function () {
            const d = describeAction(parse('SEND|0|JDOG|1.123456789|a'), { tokenDecimals: { JDOG: 8 } });
            expect(d.warnings.some(w => /more decimal places/.test(w))).to.equal(true);
        });
    });

    // . The case list above is hand-maintained, so it can only prove
    // what someone remembered to add; the confirm screen is the surface a
    // user verifies intent on, and an action nobody thought to list there
    // silently reaches a signer as "No plain-English summary is available".
    // This enumerates formats.js instead, so adding an ACTION to the
    // protocol without a describer fails here rather than on a sign screen.
    describe('every ACTION in formats.js has a describer', function () {
        for (const action of Object.keys(FORMATS)) {
            it(action, function () {
                for (const version of Object.keys(FORMATS[action])) {
                    // Params empty on purpose: a describer must produce its
                    // summary from the action + version alone, filling gaps
                    // with "?" rather than deferring to the generic path.
                    const d = describeAction({ action, params: { VERSION: version } });
                    expect(d.warnings.join('\n'), `${action} v${version}`).to.not.match(GENERIC);
                    expect(d.summary, `${action} v${version}`).to.be.a('string').and.not.equal('');
                    expect(d.summary, `${action} v${version}`).to.not.match(/^Sign /);
                }
            });
        }
    });

    describe('multi-destroy ', function () {
        it('v1 lists every leg and keeps the irreversibility warning', function () {
            const d = describeAction(parse('DESTROY|1|JDOG|5|PEPE|7|bye'));
            expect(d.summary).to.equal('Destroy: 5 JDOG, 7 PEPE');
            expect(d.warnings.join('\n')).to.include('irreversible');
            expect(d.details.find(x => x.label === 'Memo').value).to.equal('bye');
        });

        it('v2 renders the per-leg memo, not a shared one', function () {
            const d = describeAction(parse('DESTROY|2|JDOG|5|one|PEPE|7|two'));
            expect(d.summary).to.equal('Destroy: 5 JDOG, 7 PEPE');
            expect(d.details.filter(x => x.label.trim() === 'Memo').map(x => x.value))
                .to.deep.equal(['one', 'two']);
        });

        it('a non-positive leg amount is flagged', function () {
            const d = describeAction(parse('DESTROY|1|JDOG|5|PEPE|0|bye'));
            expect(d.warnings.join('\n')).to.match(/amounts are not positive/);
        });
    });

    describe('ADDRESS ', function () {
        it('v0 names the options the action actually sets', function () {
            const d = describeAction(parse('ADDRESS|0|1||2|'));
            expect(d.summary).to.include('fees destroyed');
            expect(d.summary).to.include('anyone may open a dispenser');
            expect(d.warnings.join('\n')).to.include('burned permanently');
        });

        it('v0 with every option blank says so instead of implying a change', function () {
            const d = describeAction(parse('ADDRESS|0||||'));
            expect(d.summary).to.include('no options changed');
            expect(d.warnings.join('\n')).to.include('sets no address options');
        });

        it('v0 flags a fee preference the indexer will reject', function () {
            const d = describeAction(parse('ADDRESS|0|3|||'));
            expect(d.warnings.join('\n')).to.match(/must be 0, 1 or 2/);
        });

        it('v1 bind states the symmetric transfer gate', function () {
            const d = describeAction(parse('ADDRESS|1|42|transfer|10|0'));
            expect(d.summary).to.equal('Bind this address to controller #42 (transfer)');
            expect(d.warnings.join('\n')).to.include('BOTH sends from and sends to');
        });

        it('v1 unbind reads as an unbind, not a bind', function () {
            const d = describeAction(parse('ADDRESS|1|42|transfer|10|1'));
            expect(d.summary).to.equal('Unbind controller from this address (transfer)');
            expect(d.warnings.join('\n')).to.include('after the cooldown elapses');
        });
    });

    describe('§3.5 adversarial fixtures', function () {
        it('bidi override in MEMO is neutralized and flagged', function () {
            const d = describeAction(parse('SEND|0|JDOG|1|addr|pay ‮evil‬ now'));
            expect(JSON.stringify(d.details)).to.not.include('‮');
            expect(d.warnings.some(w => /direction-control/.test(w))).to.equal(true);
        });

        it('zero-width in TICK-adjacent text is stripped and flagged', function () {
            const d = describeAction({ action: 'SEND', params: { TICK: 'JD​OG', AMOUNT: '1', DESTINATION: 'a' } });
            expect(d.details.find(x => x.label === 'Token').value).to.equal('JDOG');
            expect(d.warnings.some(w => /zero-width/.test(w))).to.equal(true);
        });

        it('exponential AMOUNT is flagged, never prettified', function () {
            const d = describeAction({ action: 'SEND', params: { TICK: 'JDOG', AMOUNT: '1e21', DESTINATION: 'a' } });
            expect(d.details.find(x => x.label === 'Amount').value).to.equal('1e21');
            expect(d.warnings.some(w => /exponential/.test(w))).to.equal(true);
        });

        it('multi-leg amounts are formatted per leg, no false junk flag', function () {
            const d = describeAction(parse('SEND|1|JDOG|1|a|2|b|m'));
            expect(d.warnings.some(w => /not a plain decimal/.test(w))).to.equal(false);
        });

        it('describe output is deduplicated and text-only', function () {
            const d = describeAction(parse('SEND|0|JDOG|1|addr|<b>x</b>'));
            // No HTML interpretation is decoder business; value passes as text.
            expect(d.details.find(x => x.label === 'Memo').value).to.equal('<b>x</b>');
        });
    });
});
