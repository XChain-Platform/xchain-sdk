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
 * Pre-flight Tier-2: BATCH (spec §4.4 + §4.7 intra-BATCH projection).
 *
 * Recurses the action checks per sub-command with findings tagged by
 * command index. THE load-bearing rule: sub-command i is checked with
 * the PROJECTED balance deltas of sub-commands < i, so a legitimate
 * MINT-then-SEND-the-minted batch does not false-alarm. Where an
 * earlier command's effect cannot be projected client-side, dependent
 * findings cap at warning (handled by severity downgrade below).
 * BATCH is sequential and stateful, NOT atomic - standing warning.
 * Each sub-action pays its own fee; the header is fee-free. Tier-1
 * denylisted.
 *
 ********************************************************************/

'use strict';

const { FINDING_CODES } = require('../constants.js');
const numeric = require('../numeric.js');

// Project a sub-command's effect on the source's token balances.
// Returns [{tick, amount}] deltas (positive = balance INCREASE) or
// null when the effect is not projectable client-side.
function projectDeltas(cmd, source) {
    if (!cmd || !cmd.ok) return [];
    const p = cmd.params || {};
    const ticks = [].concat(p.TICK || []);
    const amounts = [].concat(p.AMOUNT || []);
    switch (cmd.action) {
        case 'MINT': {
            // Credits the destination (default: source).
            const dest = p.DESTINATION ? String(p.DESTINATION) : source;
            if (dest !== source) return [];
            return ticks.length && amounts.length ? [{ tick: String(ticks[0]), amount: String(amounts[0]), sign: +1 }] : [];
        }
        case 'SEND':
        case 'DESTROY': {
            const out = [];
            const n = Math.max(ticks.length, amounts.length);
            for (let i = 0; i < n; i++) {
                const tick = String(ticks[Math.min(i, ticks.length - 1)] || '');
                const amount = String(amounts[i] !== undefined ? amounts[i] : '');
                if (tick && amount !== '') out.push({ tick, amount, sign: -1 });
            }
            return out;
        }
        default:
            return null; // not projectable (ISSUE mint-supply, sweeps, escrows, ...)
    }
}

async function checkBatch(ctx) {
    const commands = ctx.parsed.commands || [];
    ctx.addFinding(FINDING_CODES.BATCH_NOT_ATOMIC, 'warning',
        'Batch commands execute sequentially and are NOT atomic: if one fails, earlier commands still apply.',
        { commandCount: commands.length });

    // Running projected deltas, seeded from the caller's own localDeltas.
    // ctx.localDeltas is amounts to SUBTRACT; the projection uses the
    // same convention (positive amount = subtract from balance).
    const baseDeltas = ctx.localDeltas.slice();
    let projected = [];   // [{tick, amount}] to subtract
    let unprojectable = false;

    const { runActionChecks } = require('./index.js');

    for (let i = 0; i < commands.length; i++) {
        const cmd = commands[i];
        if (!cmd || cmd.ok === false) {
            ctx.addFinding(FINDING_CODES.PARSE_INVALID, 'error',
                `Batch command ${i + 1} does not parse (${cmd && cmd.code ? cmd.code : 'MALFORMED'}).`,
                { commandIndex: i, code: cmd && cmd.code });
            continue;
        }

        // Child context sharing the report sinks but with the running
        // projected deltas and the command index for finding tags.
        const child = Object.create(ctx);
        child.parsed = cmd;
        child.params = cmd.params || {};
        child.commandIndex = i;
        child.localDeltas = baseDeltas.concat(projected);
        const findingsBefore = ctx.findings.length;
        await runActionChecks(child);

        // §4.4: where an earlier command's effect could not be
        // projected, dependent balance findings cap at warning.
        if (unprojectable) {
            for (let f = findingsBefore; f < ctx.findings.length; f++) {
                const finding = ctx.findings[f];
                if (finding.severity === 'error' && finding.code === FINDING_CODES.BALANCE_INSUFFICIENT) {
                    finding.severity = 'warning';
                    delete finding.overridable;
                    finding.message += ' (an earlier batch command\'s effect could not be projected; treat as advisory)';
                }
            }
        }

        const deltas = projectDeltas(cmd, ctx.source);
        if (deltas === null) unprojectable = true;
        else {
            for (const d of deltas) {
                // sign +1 = credit => subtract a negative amount.
                projected.push({ tick: d.tick, amount: d.sign > 0 ? numeric.sub('0', d.amount) : d.amount });
            }
        }
    }
}

module.exports = { checkBatch, projectDeltas };
