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
 * XChain Platform SDK - Explorer Client
 *
 * HTTP client wrapping the xchain-explorer REST API endpoints
 *
 ********************************************************************/

const { SDKExplorerError } = require('../../utils/errors.js');

// The explorer's batch reads answer 400 above 20 addresses in one body, so the
// client refuses the same ceiling before spending a request (and, on a wallet
// under an edge limiter, before spending a rate-limit token).
const BATCH_ADDRESS_LIMIT = 20;

module.exports = {
    /*
     *  Balance & Address Methods
     */

    async getBalances(address, opts = {}) {
        return this._get('/balances/' + address, opts);
    },

    // Shared by both batch reads. A caller's own malformed list is refused here
    // rather than at the explorer, so a bug in a polling loop cannot spend a
    // request (or a rate-limit token) to be told what the client already knows.
    _assertBatchAddresses(addresses) {
        let ok = Array.isArray(addresses)
            && addresses.length > 0
            && addresses.length <= BATCH_ADDRESS_LIMIT
            && addresses.every(a => typeof a === 'string');
        if (ok) return;
        throw new SDKExplorerError(
            'INVALID_ADDRESSES',
            'addresses must be a non-empty array of at most ' + BATCH_ADDRESS_LIMIT + ' address strings',
            { count: Array.isArray(addresses) ? addresses.length : null }
        );
    },

    // The batch route answers 200 only with one entry per requested address, so
    // a 200 whose body lacks the first address is not the route at all: an
    // explorer that predates it hands every unknown POST to its JSON-RPC router,
    // which answers a -32600 error object at HTTP 200 (measured on a live
    // 0.15.3 explorer), never a 404. That shape becomes the typed
    // EXPLORER_BATCH_UNSUPPORTED so a caller can fall back to the per-address
    // reads instead of parsing an RPC error as balances.
    _assertBatchBody(body, addresses, url) {
        if (body && typeof body === 'object' && !Array.isArray(body) && Object.prototype.hasOwnProperty.call(body, addresses[0])) return body;
        throw new SDKExplorerError(
            'EXPLORER_BATCH_UNSUPPORTED',
            'Explorer does not serve ' + url + ': the answer carried no entry for the requested addresses',
            { url, data: body }
        );
    },

    // One request for up to 20 addresses, answered keyed by address with the
    // same bodies as the per-address reads (see the explorer's batch route).
    // An explorer without the route surfaces as EXPLORER_BATCH_UNSUPPORTED (or
    // EXPLORER_HTTP_404 from a deployment that 404s unknown POSTs): either is
    // the wallet's feature-detection signal.
    async getBalancesBatch(addresses, opts = {}) {
        this._assertBatchAddresses(addresses);
        let body = await this._post('/balances', { addresses }, opts);
        return this._assertBatchBody(body, addresses, '/' + this.coin + '/api/balances');
    },

    async getAddress(address, opts = {}) {
        return this._get('/address/' + address, opts);
    },

    async getPublicKey(address) {
        return this._get('/pubkey/' + address);
    },

    async getHolders(tick, opts = {}) {
        return this._get('/holders/' + tick, opts);
    },

    async getCredits(query, type, opts = {}) {
        return this._get('/credits/' + query + '/' + type, opts);
    },

    async getDebits(query, type, opts = {}) {
        return this._get('/debits/' + query + '/' + type, opts);
    },

    async getEscrows(query, type, opts = {}) {
        return this._get('/escrows/' + query + '/' + type, opts);
    },


    /*
     *  Token Methods
     */

    // Raw token read. The row arrives NESTED as { info: { tick, tick_id, ... } }
    // (some deployments answer a one-element array of that envelope), and a tick
    // that does not exist answers HTTP 404, which surfaces here as a thrown
    // SDKExplorerError with code EXPLORER_HTTP_404. Use findToken/tokenExists
    // for an existence check; see those for why the obvious ones are wrong.
    async getToken(tick, opts = {}) {
        return this._get('/token/' + tick, opts);
    },

    // The token's info record, or null when the tick does not exist.
    //
    // getToken()'s two surprises defeat the two checks a caller reaches for
    // first: reading `row.tick` off the top level reports every EXISTING token
    // absent (the fields live under .info), and "call it, treat a throw or an
    // empty body as absent" throws on every MISSING one (404, not an empty
    // 200). findToken unwraps the envelope and answers null for that 404.
    //
    // Only the 404 becomes null. A network failure, timeout, 429 or 5xx still
    // throws, because "the explorer could not answer" is not "the token does
    // not exist" and silently collapsing the two mints tokens over a blip.
    async findToken(tick, opts = {}) {
        let token;
        try {
            token = await this.getToken(tick, opts);
        } catch (err) {
            let status = err && err.details ? err.details.status : undefined;
            if (status === 404 || (err && err.code === 'EXPLORER_HTTP_404')) return null;
            throw err;
        }
        let info = token && (Array.isArray(token) ? (token[0] || {}).info : token.info);
        return (info && typeof info === 'object') ? info : null;
    },

    // Existence check that does not throw on a missing tick. Same error policy
    // as findToken: absent is false, unreachable still throws.
    async tokenExists(tick, opts = {}) {
        return (await this.findToken(tick, opts)) !== null;
    },

    // Current official-token roster of a project tick (protocol/Project_Registry.md).
    // The explorer 400s when the tick has no owner-attested roster.
    async getProject(tick) {
        return this._get('/project/' + tick);
    },

    async getTokens(query, type, opts = {}) {
        return this._get('/tokens/' + query + '/' + type, opts);
    },

    async getIssues(query, type, opts = {}) {
        return this._get('/issues/' + query + '/' + type, opts);
    },


    /*
     *  Transaction & History Methods
     */

    async getTransaction(query, type) {
        return this._get('/transaction/' + query + '/' + type);
    },

    async getAction(actionIndex) {
        return this._get('/action/' + actionIndex);
    },

    async getActions(params = {}) {
        return this._get('/actions', params);
    },

    async getBlock(blockIndex) {
        return this._get('/block/' + blockIndex);
    },

    async getHistory(query, type, opts = {}) {
        return this._get('/history/' + query + '/' + type, opts);
    },


    /*
     *  ACTION-Specific Query Methods
     */

    async getAddresses(query, type, opts = {}) {
        return this._get('/addresses/' + query + '/' + type, opts);
    },

    async getAirdrops(query, type, opts = {}) {
        return this._get('/airdrops/' + query + '/' + type, opts);
    },

    async getBatches(query, type, opts = {}) {
        return this._get('/batches/' + query + '/' + type, opts);
    },

    async getBroadcasts(query, type, opts = {}) {
        return this._get('/broadcasts/' + query + '/' + type, opts);
    },

    async getCallbacks(query, type, opts = {}) {
        return this._get('/callbacks/' + query + '/' + type, opts);
    },

    // Betting markets. type is one of block | address | source | token
    // | status, matching the explorer route map. `source` filters by the market's
    // oracle; `address` matches any participant.
    //
    // The unfiltered branch is REQUIRED, not a convenience: the explorer
    // registers `/bet_feeds` alongside `/bet_feeds/{QUERY}/{TYPE}`, and without
    // this guard a caller asking for every market interpolates the literals and
    // requests `/bet_feeds/null/null`, which 404s. That is what the wallet's "All
    // markets" filter did on every click, and no unit test could see it because
    // the SDK suite mocks this client and its consumers mock the SDK. Same shape
    // as getPrices/getVotes.
    async getBetFeeds(query, type, opts = {}) {
        if (query)
            return this._get('/bet_feeds/' + query + '/' + type, opts);
        return this._get('/bet_feeds', opts);
    },

    // One market by its FEED_ACTION_INDEX: the feed row, per-outcome pool totals,
    // bet counts, and the status timeline.
    async getBetFeed(index, opts = {}) {
        return this._get('/bet_feed/' + index, opts);
    },

    // Bets, type is one of block | address | feed | token | status.
    // Unfiltered branch for the same reason as getBetFeeds above: the explorer
    // registers a bare `/bets` route, and interpolating a null query 404s. Fixed
    // in the same pass because it is the identical latent defect, not because a
    // caller has hit it yet.
    async getBets(query, type, opts = {}) {
        if (query)
            return this._get('/bets/' + query + '/' + type, opts);
        return this._get('/bets', opts);
    },

    // An oracle's track record: markets resolved / voided / cancelled / expired,
    // fees earned, active markets. This is the v0 reputation system in full, and
    // it is per-ADDRESS: an oracle can start fresh from a new address at any
    // time, so an empty record means unknown, never safe (BET.md trust model).
    async getOracleStats(address, opts = {}) {
        return this._get('/oracle/' + address, opts);
    },

    async getDestroys(query, type, opts = {}) {
        return this._get('/destroys/' + query + '/' + type, opts);
    },

    async getCoinpays(query, type, opts = {}) {
        return this._get('/coinpays/' + query + '/' + type, opts);
    },

    async getCoinpayExpires(query, type, opts = {}) {
        return this._get('/coinpay_expires/' + query + '/' + type, opts);
    },

    async getCoinpayObligations(query, type, opts = {}) {
        return this._get('/coinpay_obligations/' + query + '/' + type, opts);
    },

    // The address-typed obligations read for up to 20 addresses in one request,
    // answered keyed by address. Same feature-detection signal as the balances
    // batch on an explorer that predates the route.
    async getCoinpayObligationsBatch(addresses, opts = {}) {
        this._assertBatchAddresses(addresses);
        let body = await this._post('/coinpay_obligations', { addresses }, opts);
        return this._assertBatchBody(body, addresses, '/' + this.coin + '/api/coinpay_obligations');
    },

    async getDispensers(query, type, opts = {}) {
        return this._get('/dispensers/' + query + '/' + type, opts);
    },

    async getDispenses(query, type, opts = {}) {
        return this._get('/dispenses/' + query + '/' + type, opts);
    },

    // Dispenser lifecycle events, type ∈ {block, address}.
    async getDispenserCancels(query, type, opts = {}) {
        return this._get('/dispenser_cancels/' + query + '/' + type, opts);
    },

    async getDispenserCloses(query, type, opts = {}) {
        return this._get('/dispenser_closes/' + query + '/' + type, opts);
    },

    async getDispenserExpires(query, type, opts = {}) {
        return this._get('/dispenser_expires/' + query + '/' + type, opts);
    },

    async getDispenserEdits(query, type, opts = {}) {
        return this._get('/dispenser_edits/' + query + '/' + type, opts);
    },

    async getDividends(query, type, opts = {}) {
        return this._get('/dividends/' + query + '/' + type, opts);
    },

    async getFees(query, type, opts = {}) {
        return this._get('/fees/' + query + '/' + type, opts);
    },

    // Native-coin fee pre-flight for one action. Proxies to the indexer's read-only `feequote`.
    // `params` is the wire param array (without the ACTION name) or a pre-joined pipe string.
    // Returns { supported, valid, error, requiredFeeNative, requiredFeeSats, feeDestination,
    //           expectedNative, minAcceptable, maxAcceptable, oracleRound, ... }.
    async getFeeQuote({ action, params, source, feeOutputSats } = {}) {
        let q = new URLSearchParams();
        if (action !== undefined && action !== null)        q.set('action', String(action));
        if (params !== undefined && params !== null)        q.set('params', Array.isArray(params) ? params.join('|') : String(params));
        if (source !== undefined && source !== null)        q.set('source', String(source));
        if (feeOutputSats !== undefined && feeOutputSats !== null) q.set('feeOutputSats', String(feeOutputSats));
        return this._get('/feequote?' + q.toString());
    },

    // Oracle usage fee quote for a Mode B dispenser. Proxies to the indexer's
    // read-only `oraclefeequote`.
    //
    // A dispenser that names an ORACLE_ADDRESS pays the oracle operator up front, as a
    // native-coin output, sized from the escrow the action adds (Counterparty parity).
    // Call this before composing a DISPENSER v0 create or a v2 refill, then pass the
    // amount as a customOutput to the oracle address:
    //
    //     const q = await explorer.getOracleFeeQuote({ oracleAddress, giveTick,
    //                                                  fiatCode, giveEscrow });
    //     if (q.valid && !q.belowDust)
    //         customOutputs.push({ address: q.oracleAddress, value: q.requiredFeeSats });
    //
    // The indexer computes this from the same code path it validates with, so an output
    // sized from the quote is accepted. Returns { valid, error, oracleAddress, blockTime,
    // requiredFeeNative, requiredFeeSats, belowDust, note }. A dispenser whose oracle has
    // published no effective price yet is rejected here and on chain: the oracle must have
    // prices set, and PRICE v1 quotes only become effective 24h after publication.
    async getOracleFeeQuote({ oracleAddress, giveCoin, giveTick, fiatCode, getCoin, giveEscrow, blockTime } = {}) {
        let q = new URLSearchParams();
        if (oracleAddress !== undefined && oracleAddress !== null) q.set('oracleAddress', String(oracleAddress));
        if (giveCoin      !== undefined && giveCoin      !== null) q.set('giveCoin',      String(giveCoin));
        if (giveTick      !== undefined && giveTick      !== null) q.set('giveTick',      String(giveTick));
        if (fiatCode      !== undefined && fiatCode      !== null) q.set('fiatCode',      String(fiatCode));
        if (getCoin       !== undefined && getCoin       !== null) q.set('getCoin',       String(getCoin));
        if (giveEscrow    !== undefined && giveEscrow    !== null) q.set('giveEscrow',    String(giveEscrow));
        if (blockTime     !== undefined && blockTime     !== null) q.set('blockTime',     String(blockTime));
        return this._get('/oraclefeequote?' + q.toString());
    },

    // Validity-first pre-flight for one action. Proxies to the indexer's read-only
    // `preflight`: "would the indexer accept this action?", decoupled from native-fee support.
    // Returns { supported, valid, status, error, guardInert, feeExempt, denied, blockIndex,
    //           blockTime, xchainFee, feeMode, feeTick, feeTokenBalance, feeAffordable }.
    //           `params` is the wire param array (without the ACTION name) or a pre-joined
    //           pipe string. noRetry is honored (best-effort pre-flight callers).
    // `feeMode` ('xchain' | 'native', optional) states how the transaction being composed will
    // settle the protocol fee; the verdict differs, because the XCHAIN mode debits the payer's
    // balance and the native mode pays a coin output. Omit it to get the chain's own
    // default mode (native on LTC/DOGE, the XCHAIN debit on BTC).
    async getPreflight({ action, params, source, feeMode } = {}, opts = {}) {
        let q = new URLSearchParams();
        if (action !== undefined && action !== null) q.set('action', String(action));
        if (params !== undefined && params !== null) q.set('params', Array.isArray(params) ? params.join('|') : String(params));
        if (source !== undefined && source !== null) q.set('source', String(source));
        if (feeMode !== undefined && feeMode !== null) q.set('feeMode', String(feeMode));
        return this._get('/preflight?' + q.toString(), opts);
    },

    // Native-coin fee schedule + current oracle prices. Proxies to the indexer's `feeschedule`.
    async getFeeSchedule() {
        return this._get('/feeschedule');
    },
};
