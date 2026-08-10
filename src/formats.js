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
 * XChain Platform SDK - ACTION Formats
 * 
 * This file defines all the various formats for ACTION commands
 * 
 ********************************************************************/

var Formats = {

    ADDRESS: {
        0: 'VERSION|FEE_PREFERENCE|REQUIRE_MEMO|DISPENSER_PREFERENCE|MEMO',
        // v1: self-signed account controller bind/unbind (programmable policy layer).
        1: 'VERSION|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO'
    },

    AIRDROP: {
        0: 'VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO',
        1: 'VERSION|LIST_ACTION_INDEX|TICK|AMOUNT|TICK|AMOUNT|MEMO',
        2: 'VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO',
        3: 'VERSION|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO|TICK|AMOUNT|LIST_ACTION_INDEX|MEMO'
    },

    BATCH: {
        0: 'VERSION|COMMAND'
    },

    // Parimutuel betting markets . One self-contained action covers the
    // whole lifecycle; BROADCAST plays no part in betting. There is deliberately
    // no edit format: markets are immutable from creation, and the pre-bet fix
    // path is cancel + recreate. Auto-selection distinguishes the three
    // FEED_ACTION_INDEX formats by the fields present (cancel has neither
    // OUTCOME nor AMOUNT, resolve has OUTCOME, place has both), but the compose
    // helpers in betting.js pin the version explicitly rather than relying on it,
    // because a resolve and a place-bet differing only by a missing AMOUNT is too
    // sharp an edge to leave to inference.
    BET: {
        0: 'VERSION|LABEL|OUTCOMES|TICK|FEE|DEADLINE|REFUND_WINDOW|MIN_AMOUNT|ALLOW_LIST|BLOCK_LIST|DETAILS|MEMO',
        1: 'VERSION|FEED_ACTION_INDEX|MEMO',
        2: 'VERSION|FEED_ACTION_INDEX|OUTCOME|AMOUNT|MEMO',
        3: 'VERSION|FEED_ACTION_INDEX|OUTCOME|MEMO'
    },

    BROADCAST: {
        0: 'VERSION|MESSAGE|VALUE',
        1: 'VERSION|MESSAGE|VALUE|FEE|MEMO',
        2: 'VERSION|MESSAGE|FEE|MEMO',
        3: 'VERSION|BROADCAST_ACTION_INDEX|VALUE|MEMO'
    },

    COLLECT: {
        // AMOUNT is an OPTIONAL trailing partial-claim amount (, indexer gate
        // PARTIAL_UNSTAKE_COLLECT): absent = claim the full unclaimed total.
        0: 'VERSION|AMOUNT'
    },

    COINPAY: {
        0: 'VERSION|ORDER_MATCH_ACTION_INDEX'
    },

    CALLBACK: {
        0: 'VERSION|TICK|MEMO'
    },

    DELEGATE: {
        0: 'VERSION|NEW_SIGNING_PUBKEY',
        1: 'VERSION|NEW_SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK',
        2: 'VERSION|SIGNING_PUBKEY',
        3: 'VERSION|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK'
    },

    DEPLOY: {
        0: 'VERSION|CODE_ENCODING|GAS_LIMIT|...CONSTRUCTOR_PARAMS',
        1: 'VERSION|CODE_ENCODING|GAS_LIMIT|CONSTRUCTOR_PARAMS|COOLDOWN_BLOCKS|SLASH_DESTINATION',
        // Chunked: code is assembled from prior v4 carrier actions keyed on CODE_HASH
        // (sha256 of the assembled UTF-8 source). v2 mirrors v0 (rest CONSTRUCTOR_PARAMS),
        // v3 mirrors v1 (fixed staking fields).
        2: 'VERSION|CODE_HASH|GAS_LIMIT|...CONSTRUCTOR_PARAMS',
        3: 'VERSION|CODE_HASH|GAS_LIMIT|CONSTRUCTOR_PARAMS|COOLDOWN_BLOCKS|SLASH_DESTINATION',
        // v4 = chunk carrier: one ordered base64 slice of a chunked contract's source.
        // CODE_PART is a substring of base64(code); plain concatenation in CHUNK_INDEX
        // order restores the base64 string exactly. The assembling DEPLOY v2/v3 verifies
        // sha256. (Formerly the standalone DEPLOYCHUNK action.)
        4: 'VERSION|CODE_HASH|CHUNK_INDEX|TOTAL_CHUNKS|CODE_PART'
    },

    DEPOSIT: {
        0: 'VERSION|CONTRACT_ACTION_INDEX|TICK|QUANTITY'
    },

    DESTROY: {
        0: 'VERSION|TICK|AMOUNT|MEMO',
        1: 'VERSION|TICK|AMOUNT|TICK|AMOUNT|MEMO',
        2: 'VERSION|TICK|AMOUNT|MEMO|TICK|AMOUNT|MEMO'
    },

    DISPENSER: {
        0: 'VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GIVE_ESCROW|GET_COIN|GET_TICK|GET_AMOUNT|GET_ADDRESS|FIAT_CODE|FIAT_AMOUNT|ORACLE_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO',
        1: 'VERSION|DISPENSER_ACTION_INDEX|MEMO',
        2: 'VERSION|DISPENSER_ACTION_INDEX|GIVE_ESCROW|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO'
    },

    DIVIDEND: {
        0: 'VERSION|TICK|DIVIDEND_TICK|AMOUNT|MEMO'
    },

    EXECUTE: {
        0: 'VERSION|CONTRACT_ACTION_INDEX|METHOD|...PARAMS'
    },

    // PC-29 /  P9: FILE format 0 gains an optional NINTH field,
    // GATE_MIN_AMOUNT, the minimum balance of GATE_TICKER a recipient must hold to
    // be given the decryption key. The eight-field form stays byte-identical, so
    // every historical FILE replays unchanged; absent or empty means no threshold.
    //
    //  Part B: a TENTH field, COMPRESSION, follows the same trailing-field
    // precedent. Empty/absent = raw (every historical FILE), '1' = deflate-raw.
    // It is PRESENTATIONAL, never consensus (spec §5.5): it tells a reader how to
    // reconstruct the original bytes and never affects validity anywhere. For a
    // token-gated FILE it means inflate-AFTER-decrypt, client-side only.
    FILE: {
        0: 'VERSION|NAME|TYPE|TITLE|MEMO|GATE_TICKER|ENCRYPTION_METHOD|KEY_HASH|GATE_MIN_AMOUNT|COMPRESSION'
    },

    ISSUE: {
        0: 'VERSION|TICK|MAX_SUPPLY|MAX_MINT|DECIMALS|DESCRIPTION|MINT_SUPPLY|TRANSFER|TRANSFER_SUPPLY|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|ALLOW_LIST|BLOCK_LIST|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO',
        1: 'VERSION|TICK|DESCRIPTION|MEMO',
        2: 'VERSION|TICK|MAX_MINT|MINT_SUPPLY|TRANSFER_SUPPLY|MINT_ADDRESS_MAX|MINT_START_BLOCK|MINT_STOP_BLOCK|MEMO',
        3: 'VERSION|TICK|LOCK_MAX_SUPPLY|LOCK_MAX_MINT|LOCK_DESCRIPTION|LOCK_SLEEP|LOCK_CALLBACK|LOCK_MINT|LOCK_MINT_SUPPLY|MEMO',
        4: 'VERSION|TICK|CALLBACK_BLOCK|CALLBACK_TICK|CALLBACK_AMOUNT|MEMO',
        5: 'VERSION|TICK|ALLOW_LIST|BLOCK_LIST|MEMO',
        // v6: bind/unbind a token's action-class to a controller contract (programmable policy layer).
        6: 'VERSION|TICK|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO'
    },

    LINK: {
        0: 'VERSION|COIN1|COIN1_ACTION_INDEX|COIN2|COIN2_ACTION_INDEX|MEMO'
    },

    LIST: {
        // ITEM is a rest-field: a LIST carries any number of items as
        // individual pipe-delimited segments (LIST|0|1|JDOG|BRRR|TEST)
        0: 'VERSION|TYPE|...ITEM',
        1: 'VERSION|EDIT|LIST_ACTION_INDEX|...ITEM'
    },

    MESSAGE: {
        0: 'VERSION|COIN|DESTINATION|ENCRYPTION_METHOD|ENCRYPTION_KEY',
        1: 'VERSION|COIN|DESTINATION|ENCRYPTION_METHOD|ENCRYPTION_KEY',
        2: 'VERSION|COIN|DESTINATION|ENCRYPTED_MESSAGE',
        3: 'VERSION|COIN|DESTINATION|PLAINTEXT_MESSAGE'
    },

    MINT: {
        0: 'VERSION|TICK|AMOUNT|DESTINATION|MEMO'
    },

    ORDER: {
        0: 'VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO',
        1: 'VERSION|ORDER_ACTION_INDEX|MEMO',
        2: 'VERSION|ORDER_ACTION_INDEX|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO'
    },

    PRICE: {
        // v0 (validator PBFT COIN/FIAT snapshot) is validator-broadcast only; not SDK-encodable.
        // v1: permissionless user-run TOKEN/FIAT price oracle (no stake required).
        1: 'VERSION|COIN|TICK|FIAT|VALUE|FEE|MEMO'
    },

    SEND: {
        0: 'VERSION|TICK|AMOUNT|DESTINATION|MEMO',
        1: 'VERSION|TICK|AMOUNT|DESTINATION|AMOUNT|DESTINATION|MEMO',
        2: 'VERSION|TICK|AMOUNT|DESTINATION|TICK|AMOUNT|DESTINATION|MEMO',
        3: 'VERSION|TICK|AMOUNT|DESTINATION|MEMO|TICK|AMOUNT|DESTINATION|MEMO'
    },

    SLEEP: {
        0: 'VERSION|RESUME_BLOCK|MEMO',
        1: 'VERSION|RESUME_BLOCK|TICK|MEMO'
    },

    STAKE: {
        1: 'VERSION|AMOUNT|SIGNING_PUBKEY',
        2: 'VERSION|AMOUNT|SIGNING_PUBKEY',
        3: 'VERSION|AMOUNT|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK'
    },

    SWAP: {
        0: 'VERSION|GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO',
        1: 'VERSION|SWAP_ACTION_INDEX|MEMO',
        2: 'VERSION|SWAP_ACTION_INDEX|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO'
    },

    SWEEP: {
        0: 'VERSION|DESTINATION|BALANCES|OWNERSHIPS|ORDERS|SWAPS|DISPENSERS|MEMO'
    },

    UNSTAKE: {
        // AMOUNT is an OPTIONAL trailing partial-unstake amount (, indexer gate
        // PARTIAL_UNSTAKE_COLLECT): absent = full sweep, present = move only AMOUNT
        // into cooldown (the residual stays staked).
        0: 'VERSION|SIGNING_PUBKEY|AMOUNT',
        1: 'VERSION|SIGNING_PUBKEY|TARGET_CONTRACT_INDEX|TICK|AMOUNT'
    },

    WITHDRAW: {
        0: 'VERSION|CONTRACT_ACTION_INDEX|TICK|QUANTITY'
    },

    // Token-weighted governance polls. v0 = create poll, v1 = cast ballot,
    // v2 = finalize (system-injected only; listed for format parity, not
    // user-encodable), v3 = set/clear standing vote delegation.
    // Must match xchain-indexer/src/actions/vote.js formats exactly.
    VOTE: {
        0: 'VERSION|TICK|END_BLOCK|OPTIONS|MAX_SELECTIONS|TALLY_MODE|WEIGHT_MODE|QUORUM|MIN_VOTERS|MIN_VOTE_BALANCE|DECIDE_THRESHOLD|QUESTION|DEPOSIT|CALLBACK_CONTRACT|CALLBACK_METHOD|CALLBACK_PARAMS|CALLBACK_ON|GAS_ESCROW|CALLBACK_DELAY_BLOCKS',
        1: 'VERSION|POLL_REF|BALLOT|MEMO',
        2: 'VERSION|POLL_REF',
        3: 'VERSION|TICK|DELEGATE_TO|MEMO'
    }

}

module.exports = Formats;