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
 * chain the platform may integrate later, is refused. It is armed per
 * testnet chain only (ACTIVATION_MIRRORS.TICK_NAMESPACE) and pre-flight
 * cannot read the including block's height, so it is a warning naming
 * the pinned heights, the same treatment as the dispenser GIVE_AMOUNT rule.
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
    FINDING_CODES, MIN_NEW_TOP_LEVEL_TICK_LENGTH, RESERVED_FUTURE_ROOTS, describeActivation, describeActivationHere,
} = require('../constants.js');
const { tokenField } = require('./mint.js');
const { ALLOWED_COINS, getCoinConfig } = require('../../coins/index.js');
const { GAS_TICK } = require('../../protocol/constants.js');
const listTickCoin = require('../../protocol/list_tick_coin.js');
const Utility = require('../../utils/utility.js');
const { parseCoinCode } = require('../../utils/endpoints.js');
const { tickCoinPrefixVerdict } = require('./issue/tick_coin_prefix.js');
const { checkMaxSupplyFormat, checkSupplyRules } = require('./issue/supply_rules.js');

const util = new Utility();
const LIST_TICK_COIN_ACTIVATION_TIMEOUT_MS = 2000;
const readListTickCoinActive = listTickCoin.isListTickCoinActive;

function activationSdk(sdk, failed) {
    const explorer = sdk && sdk.explorer;
    if (!explorer || typeof explorer.getStatus !== 'function') return sdk;
    const sdkView = Object.create(sdk);
    const explorerView = Object.create(explorer);
    explorerView.getStatus = async (...args) => {
        try {
            return await explorer.getStatus(...args);
        } catch (e) {
            failed.value = true;
            throw e;
        }
    };
    sdkView.explorer = explorerView;
    return sdkView;
}

function withActivationTimeout(promise) {
    promise.catch(() => {});
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('LIST_TICK_COIN activation lookup timed out')),
            LIST_TICK_COIN_ACTIVATION_TIMEOUT_MS
        );
        if (timer && typeof timer.unref === 'function') timer.unref();
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); }
        );
    });
}

async function listTickCoinActivation(sdk) {
    const failed = { value: false };
    try {
        const active = await withActivationTimeout(Promise.resolve().then(
            () => readListTickCoinActive(activationSdk(sdk, failed))
        ));
        return { active, unavailable: failed.value };
    } catch (e) {
        return { active: false, unavailable: true };
    }
}

listTickCoin.isListTickCoinActive = async (sdk) => (await listTickCoinActivation(sdk)).active;

// The indexer's RESERVED_TICKS: the coin roots plus the gas tick, matched against
// the upper-cased wire tick (config.js in xchain-indexer builds the same list).
const RESERVED_TICKS = Object.freeze(ALLOWED_COINS.concat(GAS_TICK));

// The plane this SDK is pointed at, read off the explorer's coin code: the native
// ticker with a network prefix (T=testnet, R=regtest, none=mainnet). Null when no
// explorer is configured or the code is not a chain coin, so a caller can tell
// "cannot decide" from "decided". Decoded through the coin registry, so a newly
// added coin needs no edit here.
function planeFromCoin(coin) {
    return parseCoinCode(coin);
}

// Mirror the handler's tick refusals in the handler's order, so the warning names
// the verdict the chain would give first. `token` is the row lookup: null for a
// fresh create, undefined when the lookup failed, an object for an existing row.
function checkTickRules(ctx, tick, token) {
    const plane = planeFromCoin(ctx.sdk && ctx.sdk.explorer && ctx.sdk.explorer.coin);
    const tickUpper = tick.toUpperCase();
    const isGasTick = tickUpper === GAS_TICK;
    const caretRef = tick.charAt(0) === '^';
    ctx.markRun(FINDING_CODES.TICK_FORMAT);

    if (caretRef) {
        const caretRuleNetwork = plane && (plane.network === 'regtest' || plane.network === 'testnet');
        if (caretRuleNetwork) {
            if (token === undefined) {
                ctx.addUnverified('ISSUE_CARET_TICK_NO_CREATE', 'token lookup unavailable');
            } else if (token === null) {
                ctx.addFinding(FINDING_CODES.TICK_FORMAT, 'warning',
                    `${tick} does not resolve to an existing token; the indexer's `
                    + 'ISSUE_CARET_TICK_NO_CREATE rule refuses a caret TICK from creating a token where armed '
                    + '(from genesis on regtest), and this warning is returned before activation on testnet.',
                    { tick, rule: 'ISSUE_CARET_TICK_NO_CREATE' });
            }
        }
        return;
    }

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
    const topLevel = !tick.includes('.');
    const isFuture = RESERVED_FUTURE_ROOTS.includes(tickUpper);
    const tooShort = topLevel && tick.length < MIN_NEW_TOP_LEVEL_TICK_LENGTH;
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
        + 'at or above the tick-namespace activation the indexer refuses a new top-level name like this; '
        + describeActivationHere('TICK_NAMESPACE', ctx.sdk) + '.',
        { tick, rule: isFuture ? 'reserved-root' : 'length' });
}

async function checkTickCoinPrefix(ctx, tick, token) {
    let activation = { active: false, unavailable: false };
    if (String(ctx.parsed.version) === '0') activation = await listTickCoinActivation(ctx.sdk);
    if (activation.unavailable) {
        ctx.addUnverified('ISSUE_TICK_COIN_PREFIX', 'activation lookup unavailable');
        return;
    }
    const result = tickCoinPrefixVerdict({
        tick,
        active: String(ctx.parsed.version) === '0' && activation.active,
        token,
    });
    if (result && result.unverified) {
        ctx.addUnverified('ISSUE_TICK_COIN_PREFIX', result.unverified);
    } else if (result && result.refuse) {
        ctx.addFinding(FINDING_CODES.VALIDATOR_SEMANTICS, 'error', result.refuse, {
            field: 'TICK', tick, root: result.root, verdict: result.refuse,
        });
    }
}

function checkBridgeChains(ctx, plane) {
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
}

// ISSUE format 7, the issuer's bridge opt-in. Every refusal raised here holds on
// every plane: below the token-bridge activation the whole format is refused as an
// unknown VERSION, and above it each rule refuses on its own.
function checkBridgeOptIn(ctx, tick, token) {
    if (String(ctx.parsed.version) !== '7') return;
    const plane = planeFromCoin(ctx.sdk && ctx.sdk.explorer && ctx.sdk.explorer.coin);

    ctx.addUnverified('ISSUE_BRIDGE_ACTIVATION',
        'ISSUE format 7 exists only at or above the token-bridge activation of the including block, and '
        + 'below it the indexer answers VERSION (unknown); pre-flight cannot read the including block height, '
        + 'and the activation is ' + describeActivation('TOKEN_BRIDGE'));

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

    checkBridgeChains(ctx, plane);

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

async function checkIssue(ctx) {
    const tick = ctx.field('TICK');
    if (!tick || Array.isArray(tick)) return;

    // `tick` may now be a `^id` reference on the edit formats (row 24 lifted the
    // validator's blanket caret refusal; tick_resolver.js compacts ISSUE.TICK on
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
    await checkTickCoinPrefix(ctx, tick, token);
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
    checkSupplyRules(ctx, tick, token);
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
