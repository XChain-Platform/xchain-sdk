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
 * XChain Platform SDK - Encoder Client
 *
 * JSON-RPC client wrapping the xchain-encoder create_tx method
 *
 ********************************************************************/

const { SDKEncoderError } = require('../../utils/errors.js');
const bitcoin = require('bitcoinjs-lib');

function buildCreateTxParams(params) {
    // `data` is optional. A transaction with no ACTION is a plain
    // payment (the encoder's create_tx contract has always allowed it, and
    // now omits the nulldata output entirely for it), which is exactly what
    // sending a chain's own native coin is. Refusing it here forced callers
    // to invent an action for a transaction that has none, and the wallet's
    // native sends duly shipped a SEND the indexer rejects on every send.
    // customOutputs must then carry the payment, or there is nothing to send.
    if (!params.data && !params.rawData
        && !(Array.isArray(params.customOutputs) && params.customOutputs.length))
        throw new SDKEncoderError(
            'MISSING_DATA',
            'createTx requires data (ACTION string), rawData, or customOutputs (payment-only)',
        );
    if (!params.pubkey)
        throw new SDKEncoderError('MISSING_PUBKEY', 'createTx requires pubkey');

    let rpcParams = {
        pubkey: params.pubkey
    };
    if (params.data) rpcParams.data = params.data;

    // Map optional fields
    if (params.change !== undefined)           rpcParams.change = params.change;
    if (params.utxos !== undefined)            rpcParams.utxos = params.utxos;
    if (params.rawData !== undefined)          rpcParams.rawData = params.rawData;
    if (params.encoding !== undefined)         rpcParams.encoding = String(params.encoding).toUpperCase();
    if (params.fee !== undefined)              rpcParams.fee = params.fee;
    if (params.feePerKb !== undefined)         rpcParams.feePerKb = params.feePerKb;
    if (params.rbf !== undefined)              rpcParams.rbf = params.rbf;
    if (params.dust !== undefined)             rpcParams.dust = params.dust;
    if (params.unconfirmed !== undefined)      rpcParams.unconfirmed = params.unconfirmed;
    if (params.compressedPubKey !== undefined) rpcParams.compressedPubKey = params.compressedPubKey;
    if (params.customOutputs !== undefined)    rpcParams.customOutputs = params.customOutputs;
    if (params.feeQuote !== undefined)         rpcParams.feeQuote = params.feeQuote;
    // Ask the encoder to attach each segwit input's full previous
    // transaction. Only a hardware signer needs it (see the encoder's own
    // note), and it costs a node round trip plus real PSBT weight per
    // input, so it is opt-in per request rather than always-on.
    if (params.attachPrevTx !== undefined)     rpcParams.attachPrevTx = params.attachPrevTx;

    // Transparent FILE payload compression. Tri-state on the
    // wire - omitted takes the encoder's deployment default (ON), and an
    // explicit false is the opt-out. Forwarded rather than defaulted here,
    // because the SDK has no way to know what the encoder it is talking to
    // was deployed with.
    if (params.compress !== undefined)         rpcParams.compress = params.compress;

    // Per-call capabilities for encoding: "AUTO". Today the only
    // key is signerSupportsTapscript, which AUTO needs before it will select
    // the Taproot envelope: the reveal must be signable before the commit is
    // broadcast, so an unaffirmed signer stays on P2WSH. The SDK does NOT
    // default encoding to AUTO - that flips only in a major version, since
    // AUTO can return a commit/reveal pair where callers expect one PSBT.
    if (params.options !== undefined)          rpcParams.options = params.options;

    return rpcParams;
}


module.exports = {

    // Accepts the full parameter set supported by xchain-encoder's create_tx
    //
    // Required:
    //   data    - ACTION string to embed (from createAction)
    //   pubkey  - sender's public key or address
    //
    // Optional:
    //   change           - change address (defaults to pubkey on encoder side)
    //   utxos            - array of UTXO objects; null = auto-fetch from UTXO tracker
    //   rawData          - additional raw data to append (used by FILE action)
    //   encoding         - force encoding: OP_RETURN, P2SH, P2WSH, MULTISIGN,
    //                      TAPROOT, or AUTO (smallest footprint the network and
    //                      signer support; can return a commit/reveal PAIR)
    //   compress         - FILE payload compression; omit for the encoder's
    //                      default (ON), false to opt out
    //   options          - { signerSupportsTapscript } for AUTO selection
    //   fee              - fixed fee in satoshis
    //   feePerKb         - fee rate in sat/KB for auto-calculation
    //   rbf              - enable Replace-by-Fee
    //   dust             - dust threshold override
    //   unconfirmed      - include unconfirmed UTXOs (default true)
    //   compressedPubKey - required for MULTISIGN encoding
    //   customOutputs    - additional transaction outputs
    //   feeQuote         - protocol fee { address, amount } from hub
    //
    // Returns: { psbt: <hex>, encoding: <string> }
    // Plus, when the encoder's transparent FILE compression ran:
    //   compression: { compressed, rawLength, storedLength, reason,
    //                  data, rawData } - `data` and `rawData` (compressed only)
    //   are the action string and payload THIS PSBT actually carries, which are
    //   not the ones submitted: compression rewrote the COMPRESSION field and
    //   deflated the payload. Every confirm check and every phase-2 rebuild must
    //   read them, or it describes/rebuilds a transaction that does not exist.
    async createTx(params) {
        let rpcParams = buildCreateTxParams(params);

        // D-7: pre-select the funding UTXOs BY ADDRESS before create_tx. Left to
        // its own devices (no `utxos` passed) the encoder resolves the funding set
        // from `pubkey`, but the utxo-tracker keys strictly on an address it can run
        // through bitcoin.address.toOutputScript and rejects a raw compressed pubkey
        // with "has no matching Script", so every wallet-driven action that relies
        // on encoder-side selection fails. Fetch the funding address's UTXO set here
        // by address and hand it to create_tx, so the encoder selects over a valid
        // set instead of falling into the pubkey lookup.
        //
        // The funding address is the address behind `pubkey`, and callers pass it
        // as `sourceAddress` (SDK-side only, NOT forwarded on the create_tx wire:
        // it is read from `params`, never copied into `rpcParams`).
        //
        // `change` is deliberately NOT a fallback here. It is only ever the same
        // address in the self-send case, and the SDK has no way to tell that case
        // apart from a change output pointed at someone else: `pubkey` is a raw
        // compressed key, which is exactly what the tracker cannot resolve to a
        // script (that is the bug this block exists to work around). Selecting a
        // funding set from a change address that is not the spender hands
        // create_tx UTXOs the signer cannot sign, so when no `sourceAddress` is
        // given we leave the encoder on its own path rather than guess.
        // Skipped when the caller hand-selected utxos or gave no source address.
        const fundingAddress = params.sourceAddress;
        if (rpcParams.utxos === undefined && fundingAddress) {
            const fetched = await this.getUTXOs(fundingAddress);
            // Preserve the encoder's M-11 freshness protection: refuse to select
            // from a view the tracker itself flags NOT synced. (Passing `utxos`
            // otherwise bypasses the encoder's own sync gate, which only runs on
            // its internal fetch path.) `sync` is absent on older trackers: fail
            // open, matching the encoder half.
            const sync = fetched && fetched.sync;
            if (sync && typeof sync === 'object' && sync.synced === false) {
                throw new SDKEncoderError(
                    'UTXO_TRACKER_STALE',
                    'utxo-tracker view is not synced; refusing to select utxos from it',
                    { sync },
                );
            }
            const fetchedUtxos = fetched && Array.isArray(fetched.utxos) ? fetched.utxos : [];
            if (fetchedUtxos.length === 0) {
                // A genuinely empty funding address. Surface a clean, caller-actionable
                // error here rather than letting the encoder re-enter its broken pubkey
                // fetch (which would throw the opaque "no matching Script").
                throw new SDKEncoderError(
                    'NO_UTXOS',
                    'no spendable UTXOs found for the funding address',
                    { address: fundingAddress },
                );
            }
            rpcParams.utxos = fetchedUtxos;
        }

        return this.rpc('create_tx', rpcParams);
    },

    // P2SH/P2WSH two-phase helper: spend an existing P2SH/P2WSH output
    // This is phase 2 of the two-transaction pattern used by P2SH/P2WSH encoding
    //
    // Required:
    //   pubkey   - sender's public key or address
    //   p2shHash - hash of the P2SH output to spend
    //   p2shHex  - full transaction hex containing the P2SH output
    //
    // Optional:
    //   change, fee, feePerKb, rbf, dust, unconfirmed, compressedPubKey, encoding, rawData
    //   compress - FILE payload compression, tri-state as on createTx. Pass
    //     `false` with the STORED bytes (create_tx's compression.data /
    //     compression.rawData) to rebuild a reveal over a payload phase 1
    //     already compressed: the reveal must reproduce the commit's chunks
    //     byte for byte, and re-deriving them here instead of carrying them
    //     makes the reveal unable to spend the commit.
    //   customOutputs - additional outputs to emit on the reveal (phase 2). On
    //     native-fee chains the protocol fee output MUST ride the reveal tx,
    //     because the indexer treats the reveal (not the funding tx) as the
    //     action and reads the fee output from it. The funding tx (phase 1) is
    //     sized by the encoder to fund these reveal outputs without emitting
    //     them, so the value is not double-paid.
    //
    // Returns: { psbt: <hex>, encoding: <string> }
    async spendP2sh(params) {
        if (!params.pubkey)
            throw new SDKEncoderError('MISSING_PUBKEY', 'spendP2sh requires pubkey');
        if (!params.p2shHash)
            throw new SDKEncoderError('MISSING_P2SH_HASH', 'spendP2sh requires p2shHash');
        if (!params.p2shHex)
            throw new SDKEncoderError('MISSING_P2SH_HEX', 'spendP2sh requires p2shHex');

        // Phase 2 must be built with the SAME action data + encoding as phase 1;
        // the encoder re-derives the reveal script chunks from them. Sending empty
        // data makes the encoder fail to build the reveal outputs.
        let rpcParams = {
            pubkey:  params.pubkey,
            p2shHash: params.p2shHash,
            p2shHex:  params.p2shHex,
            data:     params.data !== undefined && params.data !== null ? params.data : ''
        };

        if (params.encoding !== undefined)         rpcParams.encoding = String(params.encoding).toUpperCase();
        if (params.rawData !== undefined)          rpcParams.rawData = params.rawData;
        if (params.compressedPubKey !== undefined) rpcParams.compressedPubKey = params.compressedPubKey;
        if (params.change !== undefined)           rpcParams.change = params.change;
        if (params.fee !== undefined)              rpcParams.fee = params.fee;
        if (params.feePerKb !== undefined)         rpcParams.feePerKb = params.feePerKb;
        if (params.rbf !== undefined)              rpcParams.rbf = params.rbf;
        if (params.dust !== undefined)             rpcParams.dust = params.dust;
        if (params.unconfirmed !== undefined)      rpcParams.unconfirmed = params.unconfirmed;
        if (params.customOutputs !== undefined)    rpcParams.customOutputs = params.customOutputs;
        // Tri-state, forwarded rather than defaulted (see createTx). It was
        // silently dropped here while createTx forwarded it, so a caller handing
        // phase 2 already-deflated bytes could not tell the encoder to leave them
        // alone and depended on a guard firing by accident.
        if (params.compress !== undefined)         rpcParams.compress = params.compress;

        return this.rpc('create_tx', rpcParams);
    },

    // Broadcast a signed raw transaction hex to the coin node
    //
    // Required:
    //   txHex - signed raw transaction hex (from wallet.signPsbt)
    //
    // Returns: { txid: <string> }
    async broadcastTx(txHex) {
        if (!txHex)
            throw new SDKEncoderError('MISSING_TX_HEX', 'broadcastTx requires txHex (signed transaction hex)');

        return this.rpc('broadcast_tx', { tx_hex: txHex });
    },

    async getTxBlock(txid) {
        return this.rpc('get_tx_block', { txid: txid });
    },

    // Estimate fee for a transaction without signing or broadcasting.
    // Calls create_tx and returns the PSBT along with fee information.
    //
    // BOTH PSBTs returned HERE are ungated: this client is a thin RPC layer with no
    // submitted intent to reconcile against, so they are the encoder's unchecked answer.
    // Sign only via XChainSDK.estimateFees, which runs the commit through
    // reconcileEncoded and drops the reveal rather than hand back a leg it did not
    // gate, or via LifecycleManager.submitAction, which gates both.
    // Signing a raw estimateFee answer trusts the remote encoder.
    //
    // Required: same as createTx (data, pubkey)
    // Returns: { psbt, encoding, revealPsbt?, carrierScripts?, fee, inputTotal, outputTotal }
    async estimateFee(params) {
        let result = await this.createTx(params);

        // Parse PSBT to compute fee from inputs vs outputs
        let feeInfo = { psbt: result.psbt, encoding: result.encoding };
        // A TAPROOT envelope answers as a PAIR, and the reveal is what pins the commit's
        // funding leg for the caller-side reconcile gate. Dropping it here left that gate
        // unable to tell a legitimate commit leg from parked value. It is a
        // gate input, not an extra thing to sign: estimateFees consumes it and deletes it.
        if (result.revealPsbt) feeInfo.revealPsbt = result.revealPsbt;
        // The chunk lanes' redeem scripts, carried through for the same reason the
        // reveal is: they are a GATE INPUT. A P2SH/P2WSH payload lives in scripts the
        // PSBT holds only the hashes of, so without them the caller-side carrier bind
        // has nothing to hash against and cannot tell an intended action from a
        // substituted one. Dropping the field here left the estimate path structurally
        // unable to run the check the submit path runs.
        if (result.carrierScripts) feeInfo.carrierScripts = result.carrierScripts;
        try {
            let psbt = bitcoin.Psbt.fromHex(result.psbt);

            let inputTotal = 0;
            for (let i = 0; i < psbt.data.inputs.length; i++) {
                let input = psbt.data.inputs[i];
                if (input.witnessUtxo) {
                    inputTotal += input.witnessUtxo.value;
                } else if (input.nonWitnessUtxo) {
                    let tx = bitcoin.Transaction.fromBuffer(input.nonWitnessUtxo);
                    let prevIndex = psbt.txInputs[i].index;
                    inputTotal += tx.outs[prevIndex].value;
                }
            }

            let outputTotal = 0;
            let txOutputs = psbt.txOutputs;
            for (let out of txOutputs) {
                outputTotal += out.value;
            }

            feeInfo.inputTotal  = inputTotal;
            feeInfo.outputTotal = outputTotal;
            feeInfo.fee         = inputTotal - outputTotal;
        } catch (e) {
            // If PSBT parsing fails, still return the raw result
            feeInfo.fee = null;
            feeInfo.parseError = e.message;
        }

        return feeInfo;
    },

    // Fetch UTXOs for an address from the UTXO tracker (via encoder proxy)
    //
    // Required:
    //   address - coin address to query
    //
    // Returns: { utxos: [ { txid, vout, value, scriptPubKey }, ... ] }
    //   scriptPubKey is a non-empty hex string and is REQUIRED when feeding these
    //   UTXOs back into createTx({ utxos }): the encoder's validateUtxoEntry rejects
    //   any entry missing it with a -32602. A real get_utxos response always includes
    //   it; build caller-supplied utxos arrays with the full shape, not just txid/vout/value.
    async getUTXOs(address) {
        if (!address)
            throw new SDKEncoderError('MISSING_ADDRESS', 'getUTXOs requires address');

        return this.rpc('get_utxos', { address: address });
    }

};
