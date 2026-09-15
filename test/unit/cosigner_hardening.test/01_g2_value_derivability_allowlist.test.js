// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const {
    expect,
    CoSigner,
    evaluatePolicy,
    valueDerivability,
    makeAccount,
    buildSignablePsbt,
    agentNonce,
} = require('./helpers/cosigner_hardening_helpers.js');

// G2: amount caps must not silently no-op.

const capPolicy = (actions) => ({
    allowedActions: new Set(actions),
    maxPerAction:   { SEND: { '*': '100' } },     // any amount-limiting intent
});

const LOCK_V0 = { DEST_COIN: 'DOGE', DEST_ADDRESS: 'DQhLcGV1', AMOUNT: '5' };
const BURN_V1 = { BTC_ADDRESS: '1Boat', AMOUNT: '5' };

describe('G2: value-derivability allowlist', function () {

    it('denies an index-reference action under an amount cap', function () {
        // SWAP v1 cancels a swap named only by ACTION_INDEX: the value moved is a
        // property of that on-chain object, which the daemon cannot read. Before
        // the fix its amount resolved to undefined and EVERY amount gate skipped,
        // so it was approved with no enforcement and no error.
        const acct = makeAccount();
        const co   = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: capPolicy(['SEND', 'SWAP']) });
        const res  = co.process({
            psbt: buildSignablePsbt(acct, 'SWAP|1|991234|m').toHex(),
            inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
        });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('POLICY_UNBOUNDED_ACTION');
    });

    it('allows the same action when the policy expresses no amount intent', function () {
        // The gate fires on the operator's amount-limiting INTENT, not on the
        // action: a count-only policy is not lied to by an unbounded action.
        const acct = makeAccount();
        const co   = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SWAP']) } });
        const res  = co.process({
            psbt: buildSignablePsbt(acct, 'SWAP|1|991234|m').toHex(),
            inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
        });
        expect(res.approved).to.equal(true);
    });
});

describe('G2: value-derivability allowlist', function () {

    it('denies an ownership ORDER, whose escrow no amount cap can express', function () {
        // ORDER v0 is derivable in its ordinary shape (GIVE_TICK + GIVE_AMOUNT),
        // but GIVE_OWNERSHIP escrows the TOKEN'S OWNERSHIP instead - value with no
        // amount at all. The per-format entry is demoted per-request rather than
        // the whole format being refused.
        const acct = makeAccount();
        const co   = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: capPolicy(['SEND', 'ORDER']) });
        // ORDER v0: GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|
        //           GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
        const order = (giveAmount, giveOwnership) => 'ORDER|0|' + [
            'BTC', 'MYTOKEN', giveAmount, giveOwnership,
            'BTC', 'OTHER', '5', '', '1destX', '100', '', '', 'm',
        ].join('|');

        const owned = co.process({
            psbt: buildSignablePsbt(acct, order('', '1')).toHex(),
            inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
        });
        expect(owned.approved).to.equal(false);
        expect(owned.reason).to.equal('POLICY_UNBOUNDED_ACTION');

        const plain = co.process({
            psbt: buildSignablePsbt(acct, order('5', '')).toHex(),
            inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
        });
        expect(plain.approved).to.equal(true);
    });
});

describe('G2: value-derivability allowlist', function () {

    it('denies an ISSUE that hands the token ownership away', function () {
        const acct = makeAccount();
        const co   = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: capPolicy(['SEND', 'ISSUE']) });
        // ISSUE v1: TICK|DESCRIPTION|MEMO is a pure description edit -> allowed.
        expect(co.process({
            psbt: buildSignablePsbt(acct, 'ISSUE|1|MYTOKEN|a new description|m').toHex(),
            inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
        }).approved).to.equal(true);

        // ISSUE v0 with TRANSFER set hands the whole token to another address.
        const fields = new Array(23).fill('');
        fields[0] = 'MYTOKEN';                 // TICK
        fields[6] = '1attackerAddr';           // TRANSFER
        const res = co.process({
            psbt: buildSignablePsbt(acct, `ISSUE|0|${fields.join('|')}`).toHex(),
            inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
        });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('POLICY_UNBOUNDED_ACTION');
    });

    it('rejects a policy whose amount cap could never bind, at construction', function () {
        // Every decodable COINPAY format defines its value by reference, so a
        // maxPerAction.COINPAY entry is decorative. An operator who writes one
        // believes an amount ceiling is enforced; say so instead of accepting it.
        const acct = makeAccount();
        expect(() => new CoSigner({
            secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['COINPAY']), maxPerAction: { COINPAY: { '*': '10' } } },
        })).to.throw(/can never bind/);
    });
});

describe('G2: value-derivability allowlist', function () {

    it('binds VOTE escrow to the gas tick, not to the governance tick it names', function () {
        // VOTE v0's TICK names the GOVERNANCE token (the electorate), while
        // DEPOSIT and GAS_ESCROW are both denominated in gas. Binding the cap to
        // the decoded TICK charged the wrong token's budget entirely: the gas
        // ceiling never bound, and the governance token's window was consumed by
        // spending that never touched it.
        const verdict = evaluatePolicy(
            { allowedActions: ['VOTE'] },
            { action: 'VOTE', version: 0, params: { TICK: 'GOVTOKEN', DEPOSIT: '5', GAS_ESCROW: '1' } },
        );
        expect(verdict.ok).to.equal(true);
        expect(verdict.evaluation.tick).to.equal('XCHAIN');
        expect(verdict.evaluation.amount).to.equal('6');
    });

    it('conformance: every decoder-reachable format is classified', function () {
        // The CI tripwire: adding a format to formats.js without deciding whether
        // an amount cap can bind it must fail here, not silently become another
        // uncapped action in production.
        const unclassified = valueDerivability.decodableFormats().filter(({ action, version }) => {
            const byAction = valueDerivability.TABLE[action];
            return !byAction || byAction[String(version)] === undefined;
        });
        expect(unclassified.map((f) => `${f.action} v${f.version}`)).to.deep.equal([]);
    });
});

describe('G2: value-derivability allowlist', function () {

    it('conformance: no format is classified that the decoder cannot reach', function () {
        // The other direction: a stale entry for a format the decoder refuses is
        // dead weight that misleads the next reader about the enforced surface.
        const reachable = new Set(valueDerivability.decodableFormats().map((f) => `${f.action} v${f.version}`));
        const stale = [];
        for (const action of Object.keys(valueDerivability.TABLE))
            for (const version of Object.keys(valueDerivability.TABLE[action]))
                if (!reachable.has(`${action} v${version}`)) stale.push(`${action} v${version}`);
        expect(stale).to.deep.equal([]);
    });
});

// XBRIDGE is the first action whose whole point is that the value leaves this
// chain, so "an amount cap binds it" has to be true in the evaluator, not just
// asserted in the table. v0/v1 carry no TICK field at all.
describe('G2: value-derivability allowlist', function () {

    describe('XBRIDGE is derivable in both denominations', function () {

        it('resolves v0/v1 to the gas tick, so a tick-scoped cap actually binds', function () {
            // Before the ACTION_VALUE_FIELDS entry the tick resolved to undefined and a
            // maxPerAction.XBRIDGE.XCHAIN ceiling was silently skipped on every lock
            // and burn: the operator's cap existed and enforced nothing.
            for (const [version, params] of [[0, LOCK_V0], [1, BURN_V1]]) {
                const ok = evaluatePolicy(
                    { allowedActions: ['XBRIDGE'] },
                    { action: 'XBRIDGE', version, params });
                expect(ok.evaluation.tick, `v${version} tick`).to.equal('XCHAIN');
                expect(ok.evaluation.amount, `v${version} amount`).to.equal('5');

                const capped = evaluatePolicy(
                    { allowedActions: ['XBRIDGE'], maxPerAction: { XBRIDGE: { XCHAIN: '1' } } },
                    { action: 'XBRIDGE', version, params });
                expect(capped.ok, `v${version} must be refused by a 1 XCHAIN cap`).to.equal(false);
                expect(capped.violation.code).to.equal('POLICY_AMOUNT_EXCEEDED');
            }
        });
    });
});

describe('G2: value-derivability allowlist', function () {

    describe('XBRIDGE is derivable in both denominations', function () {

        it('prefers the token bridge versions own TICK over the gas default', function () {
            // v3/v4 debit the named token, so a cap keyed to the GAS tick must not
            // bind them and a cap keyed to their own tick must.
            const v3 = evaluatePolicy(
                { allowedActions: ['XBRIDGE'] },
                { action: 'XBRIDGE', version: 3, params: { TICK: 'FUFU', DEST_COIN: 'DOGE', DEST_ADDRESS: 'D1', AMOUNT: '10' } });
            expect(v3.evaluation.tick).to.equal('FUFU');

            const v4 = evaluatePolicy(
                { allowedActions: ['XBRIDGE'] },
                { action: 'XBRIDGE', version: 4, params: { TICK: 'BTC.FUFU', ORIGIN_ADDRESS: '1Boat', AMOUNT: '3' } });
            expect(v4.evaluation.tick).to.equal('BTC.FUFU');

            const gasCapped = evaluatePolicy(
                { allowedActions: ['XBRIDGE'], maxPerAction: { XBRIDGE: { XCHAIN: '1' } } },
                { action: 'XBRIDGE', version: 3, params: { TICK: 'FUFU', DEST_COIN: 'DOGE', DEST_ADDRESS: 'D1', AMOUNT: '10' } });
            expect(gasCapped.ok, 'an XCHAIN cap does not bind a FUFU lock').to.equal(true);
        });
    });
});

describe('G2: value-derivability allowlist', function () {

    describe('XBRIDGE is derivable in both denominations', function () {

        it('classifies every user-broadcast version DERIVABLE, none of them by reference', function () {
            for (const version of [0, 1, 3, 4]) {
                const c = valueDerivability.classify('XBRIDGE', version, {});
                expect(c.class, `XBRIDGE v${version}`).to.equal(valueDerivability.DERIVABLE);
                expect(c.byRef, `XBRIDGE v${version}`).to.equal(false);
            }
            // Being derivable, an amount cap on XBRIDGE is real, not decorative:
            // it must NOT be rejected at construction the way COINPAY's is.
            expect(valueDerivability.isCapInert('XBRIDGE')).to.equal(false);
        });

        it('ISSUE v7 moves no amount: it is bridgeability policy, not a transfer', function () {
            const c = valueDerivability.classify('ISSUE', 7, { TICK: 'FUFU', BRIDGE_CHAINS: 'DOGE' });
            expect(c.class).to.equal(valueDerivability.NONE);
            expect(c.blockedBy).to.equal(null);
        });
    });
});
