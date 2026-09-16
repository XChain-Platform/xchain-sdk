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
 * XChain Platform SDK - decoder.describe
 *
 * Plain-English action describer, promoted from the wallet
 * (packages/core/src/decoder/actionDecoder.js). Pure
 * function (no vault, no network); both wallet shells and any SDK
 * consumer render the same {summary, details, warnings} contract.
 *
 * Dedicated describers: ADDRESS, SEND, SWEEP, ISSUE (v0-v7), MINT,
 * DESTROY, BATCH, BROADCAST, DISPENSER, DIVIDEND, LIST, AIRDROP, ORDER,
 * SWAP, STAKE, UNSTAKE, DELEGATE, VOTE, DEPLOY, EXECUTE, DEPOSIT,
 * WITHDRAW, COINPAY, COLLECT, MESSAGE, FILE, LINK, SLEEP, CALLBACK,
 * PRICE, BET, XBRIDGE - i.e. every ACTION in formats.js, which
 * `test/unit/decoder/describe.test.js` enumerates rather than trusting
 * this list: the confirm screen is where a user verifies intent
 * before signing, so a missing case there is a coverage hole on the
 * security surface, not a cosmetic gap.
 *
 * A future action added to formats.js with no case here gets the generic
 * fallback (which still names the action and lists every parameter) and
 * fails that enumeration test. Untrusted-input hardening (bidi/zero-width
 * neutralization, canonical amount flags, own-address/contact
 * marking) is applied centrally to the finished output - see
 * hardening.js and harden() below.
 *
 ********************************************************************/

'use strict';

const { sanitizeText, formatAmount } = require('./hardening.js');
const { genericFallback } = require('./describe/value_format.js');
const { decodeAddress, decodeSend, decodeSweep } = require('./describe/transfers.js');
const { decodeMint, decodeDestroy, decodeIssue } = require('./describe/token_supply.js');
const { decodeList, decodeAirdrop, decodeDividend, decodeDispenser } = require('./describe/distributions.js');
const { decodeOrderSwap, decodeCoinpay, decodePrice, decodeBet } = require('./describe/markets.js');
const { decodeStake, decodeUnstake, decodeDelegate, decodeVote, decodeDeploy, decodeExecute, decodeContractFunds, decodeCollect } = require('./describe/staking_contracts.js');
const { decodeBroadcast, decodeMessage, decodeFile, decodeLink, decodeSleep, decodeCallback, decodeXbridge } = require('./describe/messages_bridge.js');

/*
 * @param {object} parsed  a ParsedAction from decoder.parse(), or a
 *                 legacy `{ action, params | fields }` object (the
 *                 wallet shim path; `fields` is createAction()'s name
 *                 for the same map)
 * @param {object} [ctx]
 * @param {string} [ctx.chainId]
 * @param {object} [ctx.chainRegistry]   has get(chainId) -> { displayName }
 * @param {string[]} [ctx.ownAddresses]  wallet-owned addresses; matching
 *                 destinations are marked "(your address)"
 * @param {object} [ctx.contacts]        { address: name } map; matches
 *                 are marked "(contact: name)"
 * @param {object} [ctx.tokenDecimals]   { TICK: decimals } map; when
 *                 supplied, amount precision is verified against it
 *                 (absent = precision checks are skipped, junk and
 *                 exponential notation are still flagged)
 * @returns {{ summary:string, details:Array<{label:string,value:string}>, warnings:string[] }}
 */
function describe(parsed, ctx = {}) {
    const action = parsed && parsed.action ? String(parsed.action) : '';
    const p = { ...((parsed && (parsed.params || parsed.fields)) || {}) };
    // ParsedAction carries the version top-level (parse() excludes
    // VERSION from params); versioned describers read p.VERSION.
    if (parsed && parsed.version !== undefined && parsed.version !== null && p.VERSION === undefined)
        p.VERSION = String(parsed.version);
    const { chainId, chainRegistry } = ctx;
    const descriptor = chainRegistry && chainId ? chainRegistry.get(chainId) : null;
    const chainName = (descriptor && descriptor.displayName) || chainId || '';
    const chainSuffix = chainName ? ` on ${chainName}` : '';

    let decoded;
    if (action === 'ADDRESS') decoded = decodeAddress(p, chainSuffix);
    else if (action === 'SEND') decoded = decodeSend(p, chainSuffix);
    else if (action === 'SWEEP') decoded = decodeSweep(p, chainSuffix);
    else if (action === 'ISSUE') decoded = decodeIssue(p, chainSuffix);
    else if (action === 'MINT') decoded = decodeMint(p, chainSuffix);
    else if (action === 'DESTROY') decoded = decodeDestroy(p, chainSuffix);
    else if (action === 'BATCH') decoded = decodeBatch(parsed, p, ctx, chainSuffix);
    else if (action === 'BROADCAST') decoded = decodeBroadcast(p, chainSuffix);
    else if (action === 'DISPENSER') decoded = decodeDispenser(p, chainSuffix);
    else if (action === 'DIVIDEND') decoded = decodeDividend(p, chainSuffix);
    else if (action === 'LIST') decoded = decodeList(p, chainSuffix);
    else if (action === 'AIRDROP') decoded = decodeAirdrop(p, chainSuffix);
    else if (action === 'ORDER' || action === 'SWAP') decoded = decodeOrderSwap(action, p, chainSuffix);
    else if (action === 'STAKE') decoded = decodeStake(p, chainSuffix);
    else if (action === 'UNSTAKE') decoded = decodeUnstake(p, chainSuffix);
    else if (action === 'DELEGATE') decoded = decodeDelegate(p, chainSuffix);
    else if (action === 'VOTE') decoded = decodeVote(p, chainSuffix);
    else if (action === 'DEPLOY') decoded = decodeDeploy(p, chainSuffix);
    else if (action === 'EXECUTE') decoded = decodeExecute(p, chainSuffix);
    else if (action === 'DEPOSIT' || action === 'WITHDRAW') decoded = decodeContractFunds(action, p, chainSuffix);
    else if (action === 'COINPAY') decoded = decodeCoinpay(p, chainSuffix);
    else if (action === 'COLLECT') decoded = decodeCollect(p, chainSuffix);
    else if (action === 'MESSAGE') decoded = decodeMessage(p, chainSuffix);
    else if (action === 'FILE') decoded = decodeFile(p, chainSuffix);
    else if (action === 'LINK') decoded = decodeLink(p, chainSuffix);
    else if (action === 'SLEEP') decoded = decodeSleep(p, chainSuffix);
    else if (action === 'CALLBACK') decoded = decodeCallback(p, chainSuffix);
    else if (action === 'PRICE') decoded = decodePrice(p, chainSuffix);
    else if (action === 'BET') decoded = decodeBet(p, chainSuffix);
    else if (action === 'XBRIDGE') decoded = decodeXbridge(p, chainSuffix);
    else decoded = genericFallback(action, p, chainSuffix);

    return harden(decoded, p, ctx);
}

/*
 * Central display hardening: sanitize every rendered string, flag
 * suspicious amounts, and mark known destinations. Runs on the
 * finished DecodedAction so every describer (including the generic
 * fallback and future additions) is covered by construction.
 */
function harden(decoded, p, ctx) {
    const warnings = [];
    const summary = sanitizeText(decoded.summary, warnings);

    const own = Array.isArray(ctx.ownAddresses) ? new Set(ctx.ownAddresses) : null;
    const contacts = ctx.contacts && typeof ctx.contacts === 'object' ? ctx.contacts : null;
    const decimalsMap = ctx.tokenDecimals && typeof ctx.tokenDecimals === 'object' ? ctx.tokenDecimals : null;
    const primaryTick = typeof p.TICK === 'string' ? p.TICK : null;

    const details = decoded.details.map(({ label, value }) => {
        let v = sanitizeText(value, warnings);
        // A label ending in "to" names a DESTINATION, not a quantity, even when it
        // also carries an amount word: ISSUE v2's "Transfer minted supply to" holds
        // TRANSFER_SUPPLY, an address, and running it through formatAmount flagged
        // every legitimate owner issue-and-transfer as 'not a plain decimal number'
        // on the confirm screen.
        const isDestinationLabel = /\bto$/i.test(label);
        if (/amount|supply|escrow|per unit/i.test(label) && !isDestinationLabel && v !== '') {
            // No tokenDecimals map supplied => NaN sentinel: formatAmount
            // skips both precision comparisons (frac > NaN is false) but
            // still flags junk and exponential notation. Multi-leg values
            // arrive ', '-joined; format each leg.
            const decimals = decimalsMap
                ? (primaryTick && decimalsMap[primaryTick] !== undefined ? decimalsMap[primaryTick] : null)
                : NaN;
            v = v.split(', ').map(part => formatAmount(part, decimals, warnings)).join(', ');
        }
        if ((own || contacts) && (isDestinationLabel || /destination|address/i.test(label)) && v !== '') {
            if (own && own.has(v)) v = v + ' (your address)';
            else if (contacts && typeof contacts[v] === 'string') v = v + ' (contact: ' + sanitizeText(contacts[v]) + ')';
        }
        return { label, value: v };
    });

    // Describer warnings sanitized too (they may quote raw input).
    for (const w of decoded.warnings) warnings.push(sanitizeText(w));

    // harden flags surface FIRST (tamper indicators outrank per-field
    // advisories), deduplicated.
    const merged = [...new Set(warnings)];
    return { summary, details, warnings: merged };
}

/*
 * BATCH describer. Prefers ParsedAction.commands (decoder.parse output:
 * each entry a ParsedAction or {ok:false, code}); falls back to the
 * wallet's legacy `{ COMMANDS: [{action, params}] }` shape. A failed
 * sub-parse renders as an explicit per-command line ("Command 3: ...")
 * without hiding the rest.
 */
function decodeBatch(parsed, p, ctx, chainSuffix) {
    let children = null;

    if (parsed && Array.isArray(parsed.commands) && parsed.commands.length > 0) {
        children = parsed.commands.map((cmd, i) => {
            if (!cmd || cmd.ok === false) {
                const code = cmd && cmd.code ? cmd.code : 'MALFORMED';
                return {
                    summary: `Command ${i + 1} could not be decoded (${code})`,
                    details: [],
                    warnings: [`Batch command ${i + 1} could not be decoded (${code}). Review the raw transaction carefully before signing.`],
                };
            }
            return describe(cmd, ctx);
        });
    } else if (Array.isArray(p.COMMANDS) && p.COMMANDS.length > 0) {
        children = p.COMMANDS.map((cmd) => {
            if (!cmd || typeof cmd !== 'object') {
                return {
                    summary: 'Unknown command',
                    details: [],
                    warnings: ['A batch command is malformed.'],
                };
            }
            return describe({ action: cmd.action, params: cmd.params }, ctx);
        });
    }

    if (!children || children.length === 0) {
        return {
            summary: `Batch of actions${chainSuffix}`,
            details: [],
            warnings: [
                'Batch has no decoded commands. Review the raw transaction carefully before signing.',
            ],
        };
    }

    const summaryLines = children.map((c, i) => `${i + 1}. ${c.summary}`);
    const summary = `Batch of ${children.length} action${children.length === 1 ? '' : 's'}${chainSuffix}:\n${summaryLines.join('\n')}`;

    const details = children.flatMap((child, i) => [
        { label: `Step ${i + 1}`, value: child.summary },
        ...child.details.map((d) => ({ label: `  ${d.label}`, value: d.value })),
    ]);

    const warnings = children.flatMap((child) => child.warnings);
    // BATCH is sequential and stateful, not atomic: a mid-batch reject
    // does not roll back earlier commands.
    warnings.push('Batch commands execute in order and are NOT atomic: if one fails, the earlier commands still apply.');

    return { summary, details, warnings };
}

module.exports = { describe };
