'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
const { expect } = require('chai');
const { mockSdk, notFound } = require('../../helpers/mock.js');
const config  = require('../../../../../src/config.js');
const Utility = require('../../../../../src/utils/utility.js');
const Actions = require('../../../../../src/actions/index.js');

// Run a report against a set of endpoint stubs; Tier 1 is neutralized
// (feeExempt => no verdict) so Tier-2 findings stand on their own.
function reportFor(wire, explorerSpec, opts = {}) {
    const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), ...explorerSpec } });
    return sdk.preflight(wire, { source: opts.source || 'me', preflight: opts.mode || 'report', ...opts });
}

const codes = r => r.findings.map(f => f.code + ':' + f.severity);
const has = (r, code, sev) => r.findings.some(f => f.code === code && (!sev || f.severity === sev));
const unverified = (r, check) => (r.unverified || []).some(u => u.check === check);

// Fixtures below mirror a REAL payload captured from the regtest explorer
// (`/RBTC/api/action/3543`, an open XCHAIN dispenser), not an imagined
// shape. The previous fixtures invented `/dispensers/` + three lifecycle
// streams keyed by action index; no such routes exist, so the suite was
// green over an API that 404s in production and every live DISPENSE
// pre-flight answered "dispenser does not exist".
const dispenserAction = (over = {}, state = {}) => ({
    action: 'DISPENSER',
    action_index: '42',
    source: 'me',
    get_address: 'me',
    give_coin: 'BTC',
    give_tick: 'XCHAIN',
    give_amount: '25',
    give_escrow: '100',
    get_amount: '5',
    oracle_address: null,
    status: 'valid',
    ...over,
    state: { give_remaining: '100', expiration: '1792923623', status: 'open', ...state },
});

module.exports = {
    Actions,
    Utility,
    codes,
    config,
    dispenserAction,
    expect,
    has,
    notFound,
    reportFor,
    unverified,
};
