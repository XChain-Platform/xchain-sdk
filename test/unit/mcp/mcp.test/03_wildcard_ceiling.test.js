'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { buildServer } = require('../../../../mcp/server.js');
const { evaluatePolicy } = require('../../../../src/cosigner/policy_evaluator.js');

const build = (policy) => () => buildServer({
    sdkFactory: () => ({ agentSession: () => ({ address: 'agentaddr' }) }),
    wallet: { wif: 'W', policy },
});

const send = (tick, amount) => ({ action: 'SEND', version: 0, params: { TICK: tick, AMOUNT: amount, DESTINATION: 'dest' } });

describe('MCP wallet ceiling must bind every tick', function () {
    it('refuses a cap table that names only some ticks', function () {
        const refused = [
            { allowedActions: ['SEND'], maxPerAction: { SEND: { TOK: '5' } } },
            { allowedActions: ['SEND'], maxPerWindow: { hours: 24, perTick: { TOK: '10' } } },
            { allowedActions: ['SEND'], maxPerAction: { SEND: { TOK: '5' } }, maxPerWindow: { hours: 24, perTick: { TOK: '10' } } },
        ];
        for (const policy of refused)
            expect(build(policy), JSON.stringify(policy)).to.throw(/SEND without a binding amount ceiling for every token/);
    });

    it('refuses a wildcard that is empty or only inherited', function () {
        const refused = [
            { allowedActions: ['SEND'], maxPerAction: { SEND: { TOK: '5', '*': '' } } },
            { allowedActions: ['SEND'], maxPerAction: { SEND: Object.create({ '*': '5' }) } },
            { allowedActions: ['SEND'], maxPerWindow: { hours: 24, perTick: Object.create({ '*': '5' }) } },
        ];
        for (const policy of refused) expect(build(policy), JSON.stringify(policy)).to.throw(/binding amount ceiling/);
    });

    it('names the action whose wildcard is missing when another action has one', function () {
        const mixed = { allowedActions: ['SEND', 'MINT'], maxPerAction: { SEND: { '*': '0' }, MINT: { TOK: '5' } } };
        expect(build(mixed)).to.throw(/MINT without a binding amount ceiling/);
    });

    it('accepts a wildcard on each action, or one in the window table', function () {
        expect(build({ allowedActions: ['SEND'], maxPerAction: { SEND: { TOK: '5', '*': '0' } } })).to.not.throw();
        expect(build({
            allowedActions: ['SEND', 'MINT'], maxPerWindow: { hours: 24, perTick: { '*': '10' } },
        })).to.not.throw();
        expect(build({
            allowedActions: ['SEND', 'MINT'], maxPerAction: { SEND: { '*': '0' }, MINT: { '*': '3' } },
        })).to.not.throw();
    });

    it('the evaluator holds an unlisted tick to the wildcard the gate now requires', function () {
        const policy = { allowedActions: ['SEND'], maxPerAction: { SEND: { TOK: '5', '*': '0' } } };
        expect(evaluatePolicy(policy, send('TOK', '5')).ok).to.equal(true);
        const over = evaluatePolicy(policy, send('TOK', '6'));
        expect(over.violation.code).to.equal('POLICY_AMOUNT_EXCEEDED');
        const other = evaluatePolicy(policy, send('XCHAIN', '1'));
        expect(other.violation.code).to.equal('POLICY_AMOUNT_EXCEEDED');
    });

    it('control: the evaluator leaves an unlisted tick unbounded when no wildcard exists', function () {
        const policy = { allowedActions: ['SEND'], maxPerAction: { SEND: { TOK: '5' } } };
        expect(evaluatePolicy(policy, send('XCHAIN', '1000000')).ok).to.equal(true);
    });
});
