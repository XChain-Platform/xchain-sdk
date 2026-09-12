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
 * Pre-flight Tier-2: ISSUE (spec §4.4; mirrors xchain-indexer
 * src/actions/issue.js). THE load-bearing correction from the
 * ground-truthing pass: existence alone is NOT a reject (format 0 is
 * create-or-edit); the reject is existence AND caller is not the
 * owner. Fee only on create (issue.js:531). Lock ratchets,
 * isDistributed callback freeze, and TICK reserved tables are
 * internal; TICK charset mirrors as warning only.
 *
 * Two lock-side movements since, both server-side and both already
 * inside the ISSUE_LOCK_RATCHETS declaration: LOCK_NULL_PRIOR_UNSET
 * makes an absent prior read as UNSET rather than locked,
 * which strictly narrows the "(locked)" rejection, and it is resolved
 * once per action so the gate cannot differ field to field. The
 * TRANSFER / TRANSFER_SUPPLY `^<id>` rejection added at the caret-ref
 * strict-activation flag-day is covered by the universal address-ref check, which is
 * where it belongs: it is the same rule on five other actions, and
 * ISSUE's genesis path skips the isCryptoAddress checks that used to
 * be the only thing catching it.
 *
 * TICK NAMESPACE (the token bridge spec). Three tick refusals are
 * mirrored below, as TICK_FORMAT warnings because that code is not
 * error-certified. Two are UNCONDITIONAL on every plane and every
 * height: the reserved names (coin roots plus the gas tick) are
 * matched case-folded, with the gas tick exempt for the GAS address
 * and for every source on regtest; and the gas tick is refused off
 * BTC from every source, because off BTC its supply is the shadow of
 * an escrow the bridge alone may create. The third is ACTIVATION-KEYED
 * and creation-only: at/above the tick-namespace flag-day a NEW
 * top-level name shorter than four characters, or one held for a
 * chain the platform may integrate later, is refused. Mainnet and
 * testnet are not armed for it and pre-flight cannot read the
 * including block's height, so it is a warning that names the
 * condition, the same treatment as the dispenser GIVE_AMOUNT rule.
 *
 * ISSUE FORMAT 7 is the issuer's bridge opt-in (BRIDGE_CHAINS,
 * MIN_DEPTH, LOCK_BRIDGE). Below the token-bridge activation the
 * format does not exist ('VERSION (unknown)'), above it each field
 * rule refuses on its own, so every static refusal here is certain
 * on every plane: an unknown tick, a subasset, a BRIDGE_CHAINS entry
 * that is not another chain, a non-digit MIN_DEPTH, a LOCK_BRIDGE
 * outside 0/1. The lock and the policy mutual exclusion (controller
 * bindings, allow/block lists, the bridged bit) need row state the
 * explorer does not serve, so they are declared.
 *
 ********************************************************************/

'use strict';

const {
    FINDING_CODES, MIN_NEW_TOP_LEVEL_TICK_LENGTH, RESERVED_FUTURE_ROOTS,
} = require('../constants.js');
const numeric = require('../numeric.js');
const { tokenField } = require('./mint.js');
const { ALLOWED_COINS, getCoinConfig } = require('../../coins/index.js');
const { GAS_TICK } = require('../../protocol/constants.js');
const Utility = require('../../utility.js');

const util = new Utility();

// The indexer's RESERVED_TICKS: the coin roots plus the gas tick, matched against
// the upper-cased wire tick (config.js in xchain-indexer builds the same list).
const RESERVED_TICKS = Object.freeze(ALLOWED_COINS.concat(GAS_TICK));

// The plane this SDK is pointed at, read off the explorer's coin code: the native
// ticker with a network prefix (T=testnet, R=regtest, none=mainnet). Null when no
// explorer is configured or the code is not a chain coin, so a caller can tell
// "cannot decide" from "decided". (Same shape as nativeTickerFromCoin in
// universal.js; kept local to avoid a cross-module import cycle.)
function planeFromCoin(coin) {
    const m = /^([TR]?)(BTC|LTC|DOGE)$/.exec(String(coin || '').toUpperCase());
    if (!m) return null;
    const network = m[1] === 'T' ? 'testnet' : m[1] === 'R' ? 'regtest' : 'mainnet';
    return { coin: m[2], network };
}

// Mirror the handler's tick refusals in the handler's order, so the warning names
// the verdict the chain would give first. `token` is the row lookup: null for a
// fresh create, undefined when the lookup failed, an object for an existing row.
function checkTickRules(ctx, tick, token) {
    const plane = planeFromCoin(ctx.sdk && ctx.sdk.explorer && ctx.sdk.explorer.coin);
    const tickUpper = tick.toUpperCase();
    const isGasTick = tickUpper === GAS_TICK;
    ctx.markRun(FINDING_CODES.TICK_FORMAT);

    if (RESERVED_TICKS.includes(tickUpper)) {
        // The gas tick's exemption turns on the plane (regtest) or the source (the GAS
        // address); without a plane neither half can be decided, so say so.
        if (isGasTick && !plane) {
            ctx.addUnverified('ISSUE_GAS_TICK',
                'the gas tick is reserved except for the GAS address (every source on regtest) and is '
                + 'refused off BTC from every source; no chain coin is configured, so neither can be decided');
            return;
        }
        const gasAddress = isGasTick ? getCoinConfig(plane.coin, plane.network).addresses.GAS : null;
        const exempt = isGasTick && (plane.network === 'regtest' || (ctx.source && ctx.source === gasAddress));
        if (!exempt) {
            ctx.addFinding(FINDING_CODES.TICK_FORMAT, 'warning',
                `${tick} is a reserved name (matched case-folded); the indexer refuses this ISSUE.`,
                { tick, rule: 'reserved' });
            return;
        }
        if (plane.coin !== 'BTC') {
            ctx.addFinding(FINDING_CODES.TICK_FORMAT, 'warning',
                `${tick} can only be issued on BTC; off BTC its supply is created by the bridge alone, `
                + 'so the indexer refuses this ISSUE.',
                { tick, rule: 'btc-only', coin: plane.coin });
        }
        return;
    }

    // Creation-only namespace rules at/above the tick-namespace flag-day. A `^id`
    // reference names an existing row, so the floor never applies to it, and a
    // dotted child is measured on its own full length by the handler too.
    const caretRef = tick.charAt(0) === '^';
    const topLevel = caretRef || !tick.includes('.');
    const isFuture = RESERVED_FUTURE_ROOTS.includes(tickUpper);
    const tooShort = !caretRef && topLevel && tick.length < MIN_NEW_TOP_LEVEL_TICK_LENGTH;
    if (!isFuture && !tooShort) return;
    if (token === undefined) {
        ctx.addUnverified('ISSUE_TICK_NAMESPACE', 'token lookup unavailable');
        return;
    }
    if (token !== null) return; // an existing row keeps its name; the rule is creation-only
    ctx.addFinding(FINDING_CODES.TICK_FORMAT, 'warning',
        (isFuture
            ? `${tick} is held for a chain the platform may integrate later; `
            : `${tick} is shorter than ${MIN_NEW_TOP_LEVEL_TICK_LENGTH} characters; `)
        + 'at or above the tick-namespace activation the indexer refuses a new top-level name like this, '
        + 'and neither mainnet nor testnet is armed for it.',
        { tick, rule: isFuture ? 'reserved-root' : 'length' });
}

// ISSUE format 7, the issuer's bridge opt-in. Every refusal raised here holds on
// every plane: below the token-bridge activation the whole format is refused as an
// unknown VERSION, and above it each rule refuses on its own.
function checkBridgeOptIn(ctx, tick, token) {
    if (String(ctx.parsed.version) !== '7') return;
    const plane = planeFromCoin(ctx.sdk && ctx.sdk.explorer && ctx.sdk.explorer.coin);

    ctx.addUnverified('ISSUE_BRIDGE_ACTIVATION',
        'ISSUE format 7 exists only at or above the token-bridge activation of the including block, and '
        + 'below it the indexer answers VERSION (unknown); the activation state is server-side only, and '
        + 'neither mainnet nor testnet is armed for it');

    // Format 7 edits an existing row and carries no creation fields, so an unknown
    // tick is a refusal, never a create. Universal skips the token-exists check for
    // ISSUE because format 0 creates; this is the one format that cannot.
    ctx.markRun(FINDING_CODES.TOKEN_NOT_FOUND);
    if (token === null) {
        ctx.addFinding(FINDING_CODES.TOKEN_NOT_FOUND, 'error',
            `Token ${tick} does not exist on this chain; ISSUE format 7 edits an existing token.`,
            { field: 'TICK', tick });
    }

    // Subassets are not bridgeable yet, and the refusal is on the whole format. The
    // RESOLVED name is judged: a `^id` reference to a dotted row is refused as well,
    // so the row's own tick is read first and the wire field is the fallback.
    const resolved = token ? (tokenField(token, ['info.tick', 'tick', 'TICK']) || tick) : tick;
    if (resolved.includes('.')) {
        ctx.addFinding(FINDING_CODES.TICK_FORMAT, 'warning',
            `${resolved} is a subasset; subassets are not bridgeable yet, so the indexer refuses this ISSUE.`,
            { tick: resolved, rule: 'subasset' });
    }

    // BRIDGE_CHAINS: a comma list of OTHER chain coins, or the sentinel '-' for none.
    // Empty means unchanged, as every ISSUE field. Entries are upper-cased and not
    // trimmed, exactly as the handler splits them.
    ctx.markRun(FINDING_CODES.VALIDATOR_SEMANTICS);
    const chains = ctx.field('BRIDGE_CHAINS');
    if (chains && chains !== '-') {
        for (const chain of chains.split(',')) {
            const c = chain.toUpperCase();
            if (!ALLOWED_COINS.includes(c) || (plane && c === plane.coin)) {
                ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error',
                    `BRIDGE_CHAINS entry "${chain}" is not another chain coin (one of ${ALLOWED_COINS.join(', ')}, `
                    + 'excluding this chain).',
                    { field: 'BRIDGE_CHAINS', value: chain });
                break;
            }
        }
    }

    // MIN_DEPTH is a raise-only confirmation depth: digits only.
    const minDepth = ctx.field('MIN_DEPTH');
    if (minDepth && !/^\d+$/.test(minDepth)) {
        ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error',
            'MIN_DEPTH must be a whole number of confirmations (digits only).',
            { field: 'MIN_DEPTH', value: minDepth });
    }

    // LOCK_BRIDGE takes the lock discipline every other LOCK field has: 0 or 1.
    const lockBridge = ctx.field('LOCK_BRIDGE');
    if (lockBridge && !util.isValidLockValue(lockBridge)) {
        ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error',
            'LOCK_BRIDGE must be 0 or 1.',
            { field: 'LOCK_BRIDGE', value: lockBridge, constraint: { valid: [0, 1] } });
    }
}

// MAX_SUPPLY fractional precision, measured at the decimals CONSENSUS uses.
//
// The static validator range-checks `split('.')[0]` and throws the fraction away, so
// MAX_SUPPLY=1.5 with DECIMALS=0 cleared the SDK and was then refused on-chain as
// 'invalid: MAX_SUPPLY (format)' with the miner fee already spent. The check belongs
// HERE rather than in the validator because issue.js:258 resolves tick_decimals from
// the TOKEN ROW first and falls back to the wire DECIMALS only when the row carries
// none: on a re-issue the wire value is not the tick's decimals, so an offline reject
// keyed to it would block an action consensus accepts (an 8-decimal token re-issued
// with a stale DECIMALS=0 and MAX_SUPPLY=1000.5 is legal on-chain). Pre-flight is the
// one SDK layer that can read the row, so it is the one that can ask the question.
//
// Only MAX_SUPPLY: it is the AMOUNT-family field carried by ISSUE v0, the format that
// also carries DECIMALS. CALLBACK_AMOUNT is measured against CALLBACK_TICK's own row
// (a second lookup) and is left to the server-side residue note.
function checkMaxSupplyFormat(ctx, tick, token) {
    const value = ctx.field('MAX_SUPPLY');
    if (!value || Array.isArray(value)) return;

    const rowDecimals = token
        ? tokenField(token, ['supply.decimals', 'info.decimals', 'decimals', 'DECIMALS'])
        : null;
    const wireDecimals = ctx.field('DECIMALS');
    const decimals = rowDecimals !== null && rowDecimals !== undefined && rowDecimals !== ''
        ? rowDecimals
        : (wireDecimals === '' ? null : wireDecimals);

    ctx.markRun(FINDING_CODES.AMOUNT_FORMAT_INVALID);
    // The check below is the LEGACY amount-format rule (see numeric.js). Above its
    // flag-day the indexer also requires every AMOUNT-class field to denote the number
    // the ledger credits, which pre-flight cannot decide: it needs the activation state
    // of the block that will carry the action. Declared rather than raised, because
    // neither mainnet nor testnet is armed and rejecting here would block an ISSUE both
    // planes accept. Filed before the NaN-decimals return, because the representability
    // rule does not depend on a resolved precision for its integer-width leg.
    ctx.addUnverified('AMOUNT_REPRESENTABILITY',
        'above its flag-day an AMOUNT-class field must be a plain decimal numeral denoting the number the '
        + 'ledger credits, so exponent notation and an integer too wide for the ledger aggregation are '
        + 'rejected instead of crediting a different number; the activation state of the including block '
        + 'is server-side only, and neither mainnet nor testnet is armed for it');
    // Neither side resolves a precision: that is consensus's own NaN-decimals case, which
    // imposes no cap at all, so asserting one here would be stricter than the chain.
    if (decimals === null) return;
    if (!numeric.isValidAmountFormat(decimals, value)) {
        ctx.addFinding(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'error',
            `MAX_SUPPLY ${value} is not a valid amount at ${decimals} decimals for ${tick}.`,
            { tick, maxSupply: value, decimals });
    }
}

async function checkIssue(ctx) {
    const tick = ctx.field('TICK');
    if (!tick || Array.isArray(tick)) return;

    // `tick` may now be a `^id` reference on the edit formats (row 24 lifted the
    // validator's blanket caret refusal; tickResolver.js compacts ISSUE.TICK on
    // formats 6/7 only). No separate id-to-name resolution step runs here: ctx.token
    // forwards the wire value verbatim to explorer.getToken, which the indexer's
    // own explorer already resolves by id (xchain-explorer/src/db.js getToken():
    // `search.charAt(0)==='^'` switches the WHERE clause to `t1.tick_id=?`, the same
    // path a caret name takes on every other TICK_REF_FIELDS lookup - see
    // preflight/universal.js's token-exists loop, which passes a compacted MINT/SEND
    // tick through unchanged the same way). A canonical, existing id therefore comes
    // back as a normal token row (no false TOKEN_NOT_FOUND below); an id that
    // resolves to nothing 404s and is correctly reported absent, same as an unknown
    // name.
    const token = await ctx.token(tick);
    checkTickRules(ctx, tick, token);
    // The format-7 field rules need no row, so they run before the lookup gate below.
    checkBridgeOptIn(ctx, tick, token);
    ctx.markRun(FINDING_CODES.NOT_OWNER);
    if (token === undefined) {
        ctx.addUnverified(FINDING_CODES.NOT_OWNER, 'token lookup unavailable');
        // The MAX_SUPPLY precision check is skipped with it: without the row there is no
        // way to tell a create's authoritative DECIMALS from a re-issue's stale one.
        ctx.addUnverified(FINDING_CODES.AMOUNT_FORMAT_INVALID, 'token lookup unavailable');
        return;
    }
    checkMaxSupplyFormat(ctx, tick, token);
    if (token === null) return; // fresh create: nothing further to gate

    const owner = tokenField(token, ['info.owner', 'owner', 'OWNER', 'owner_address', 'issuer']);
    if (!ctx.source) {
        ctx.addUnverified(FINDING_CODES.NOT_OWNER, 'no source address supplied');
    } else if (owner && owner !== ctx.source) {
        ctx.addFinding(FINDING_CODES.NOT_OWNER, 'error',
            `${tick} exists and is owned by ${owner}; only the owner can edit it.`,
            { tick, owner, source: ctx.source });
    }

    ctx.addUnverified('ISSUE_LOCK_RATCHETS',
        'lock ratchets vs requested edits, isDistributed callback freeze, and reserved-TICK tables are server-side only');
    // The bridge opt-in and a chain-local policy exclude each other at/above the
    // token-bridge activation, in both directions: format 7 on a token with a
    // controller binding or an allow/block list, and formats 0/5/6 taking a list or
    // a binding onto a token that is bridgeable or has bridged. The explorer's token
    // document carries none of the row state that decides it.
    ctx.addUnverified('ISSUE_BRIDGE_POLICY_EXCLUSION',
        'a bridge opt-in (format 7) on a token with a controller binding or an allow/block list, a '
        + 'later edit of BRIDGE_CHAINS or MIN_DEPTH under LOCK_BRIDGE, and a list or binding edit on a '
        + 'token that is bridgeable or has bridged are refused at or above the token-bridge activation; '
        + 'the bindings, lists, lock and bridged bit are server-side only');
}

module.exports = { checkIssue, planeFromCoin };
