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
 ********************************************************************/

'use strict';

const mathjs = require('mathjs');

/*
 * Per-payee COINPAY payment-output planning (spec row 31).
 *
 * Inside a batch, each COINPAY obligation resolves its own payment output by FIRST
 * MATCH on the payee address over the batch's vout-sorted output set
 * (xchain-indexer/src/actions/coinpay.js `findPaymentOutput`), and the consumed-value
 * ledger then draws down THAT one output for every obligation owed to the same payee
 * (`coinPayeeConsumed`). So an obligation to a payee who is ALSO paid by a second,
 * later output can never reach that second output: only the first-matching one is ever
 * read, no matter how many obligations remain unsettled. A composer settling two
 * obligations to the same seller in one batch must therefore combine both amounts into
 * ONE output for that payee, never split them across two.
 *
 * This applies only on the BATCHED path, and only once BOTH gates the behaviour
 * depends on are armed: `BATCH_SUBCOMMAND_OUTPUT_CAPTURE_ACTIVATION` (decoder, so a
 * batched COINPAY's payment output reaches the indexer at all - genesis-active on
 * testnet/regtest, mainnet at 2026-08-16T00:00:00Z) and `BATCH_ISSUANCE_LIMITS`
 * (indexer, so the per-payee resolution below ever runs - mainnet at the SAME instant).
 * Both were armed together on 2026-08-14 precisely so no window exists where one is
 * live and the other is not. BELOW that instant a batched COINPAY settles nothing
 * regardless of the output plan (row 21), so this planner's rule has no live consensus
 * consequence on mainnet history; at and above it, the rule is load-bearing and a
 * composer that ignores it loses a settlement.
 *
 * WHAT THIS CANNOT VERIFY FROM STRINGS ALONE: matching is exact string equality
 * between the `payee` / `address` you pass here and the address the FINISHED
 * transaction's output will actually carry, mirroring the indexer's own
 * `output.address === address` test with no normalization on either side. A payee
 * address written two different but equivalent ways (case, an alternate valid
 * encoding) is two different pools here and on chain; this planner declares that
 * rather than attempting address canonicalization it has no chain context to perform
 * correctly, the same honesty `mintTickKey`'s caret declaration states in batch_limits.js.
 */

/*
 * Derive the minimal per-payee output plan for a list of COINPAY obligations.
 *
 * obligations: [{ payee, amount }], amount a decimal string or number.
 * Returns: [{ payee, amount }], ONE entry per DISTINCT payee in first-appearance
 * order, amount the decimal-string SUM of every obligation owed to that payee.
 *
 * This is the shape a composer should build payment outputs from: one output per
 * returned entry. Distinct payees' outputs may land at any relative vout (matching is
 * per-address, not per-position); it is entries for the SAME payee that must never be
 * split across two outputs.
 */
function planCoinpayOutputs(obligations) {
    const order = [];
    const totals = new Map();
    for (const obligation of (obligations || [])) {
        if (!obligation || obligation.payee === undefined || obligation.payee === null) continue;
        const payee = String(obligation.payee);
        const amount = (obligation.amount === undefined || obligation.amount === null) ? '0' : obligation.amount;
        if (!totals.has(payee)) {
            totals.set(payee, mathjs.bignumber(0));
            order.push(payee);
        }
        totals.set(payee, mathjs.add(totals.get(payee), mathjs.bignumber(String(amount))));
    }
    return order.map(payee => ({
        payee,
        amount: mathjs.format(totals.get(payee), { notation: 'fixed' }),
    }));
}

/*
 * Check a PLANNED output set against a list of obligations, resolving each one exactly
 * as the arbiter does: the output that settles an obligation is the FIRST entry in
 * `outputs` (array order stands in for vout order) whose address equals the
 * obligation's payee, and every obligation naming that SAME payee draws on that SAME
 * output (owed amounts summed; surplus above the total owed stays in the pool - R5b).
 *
 * obligations: [{ payee, amount }]
 * outputs:     [{ address, amount }], in the order they will appear as outputs
 *              (lowest vout first)
 *
 * Returns { ok, violations }. `violations` is a list of
 * { payee, owed, available, reason }, `reason` one of:
 *   'NO_OUTPUT'    no output in the set pays this payee at all
 *   'INSUFFICIENT' the first matching output's amount is less than the SUM owed to
 *                  this payee across every obligation naming it
 *
 * A payee paid by two or more outputs in `outputs` is not itself flagged as a shape
 * error (extra outputs to an already-settled payee are simply invisible to
 * settlement, not rejected); it is comparing owed amounts against only the FIRST
 * match that surfaces the composition mistake this function exists to catch -
 * splitting one payee's combined amount across two outputs reads here as
 * INSUFFICIENT against the first (smaller) one, exactly as it would on chain.
 */
function checkCoinpayOutputPlan(obligations, outputs) {
    const list = Array.isArray(outputs) ? outputs : [];
    const owed = new Map();
    const order = [];
    for (const obligation of (obligations || [])) {
        if (!obligation || obligation.payee === undefined || obligation.payee === null) continue;
        const payee = String(obligation.payee);
        const amount = (obligation.amount === undefined || obligation.amount === null) ? '0' : obligation.amount;
        if (!owed.has(payee)) {
            owed.set(payee, mathjs.bignumber(0));
            order.push(payee);
        }
        owed.set(payee, mathjs.add(owed.get(payee), mathjs.bignumber(String(amount))));
    }

    const violations = [];
    for (const payee of order) {
        // FIRST match only, identical to xchain-indexer/src/actions/coinpay.js
        // findPaymentOutput: a second output paying the same address is never read.
        const output = list.find(entry => entry && String(entry.address) === payee);
        const total = owed.get(payee);
        if (!output) {
            violations.push({
                payee,
                owed: mathjs.format(total, { notation: 'fixed' }),
                available: '0',
                reason: 'NO_OUTPUT',
            });
            continue;
        }
        const rawAvailable = (output.amount === undefined || output.amount === null) ? '0' : output.amount;
        const available = mathjs.bignumber(String(rawAvailable));
        if (mathjs.smaller(available, total)) {
            violations.push({
                payee,
                owed: mathjs.format(total, { notation: 'fixed' }),
                available: mathjs.format(available, { notation: 'fixed' }),
                reason: 'INSUFFICIENT',
            });
        }
    }
    return { ok: violations.length === 0, violations };
}

module.exports = {
    planCoinpayOutputs,
    checkCoinpayOutputPlan,
};
