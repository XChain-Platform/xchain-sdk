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
 * XChain Platform SDK - Transaction Lifecycle Manager
 *
 * Orchestrates the full transaction pipeline:
 * create → encode → sign → broadcast → (P2SH phase 2) → wait for indexer
 *
 ********************************************************************/

const ActionWaiter = require('../../utils/action_waiter.js');
const { SDKConfigError } = require('../../utils/errors.js');

module.exports = {
    // Gate on the contract's own state before handing the result back.
    //
    // This is the settle-safe boundary: a caller that deposits and then settles
    // must not build the settling transaction until the contract has actually
    // been credited, because the deposit's inputs are gone the moment it lands
    // and the VM would revert on a balance that is not there yet. Both waits
    // are bounded and fail CLOSED - a gate that never sees the state throws
    // rather than letting the caller proceed on an assumption.
    async _awaitContract(result, actionData, opts, progress, finalTxid) {
        let gate  = opts.awaitContract;
        let index = (gate.contractActionIndex !== undefined && gate.contractActionIndex !== null)
            ? gate.contractActionIndex
            : this.constructor._contractIndexOf(actionData);
        if (index === undefined || index === null || index === '')
            throw new SDKConfigError('MISSING_CONTRACT_INDEX',
                'opts.awaitContract needs a contractActionIndex; this action does not carry one');

        let waitOpts = {
            timeout:      gate.timeout      !== undefined ? gate.timeout      : (opts.timeout || 120000),
            pollInterval: gate.pollInterval !== undefined ? gate.pollInterval : (opts.pollInterval || 2000),
            explorer:     opts.explorer,
            explorerUrl:  opts.explorerUrl,
            explorerPort: opts.explorerPort
        };
        let waiter = new ActionWaiter(this.sdk);

        try {
            if (gate.key !== undefined || typeof gate.match === 'function') {
                progress('waiting_contract_state', { contractActionIndex: index, key: gate.key });
                result.contractState = await waiter.waitForContractState(index, Object.assign({}, waitOpts, {
                    key:    gate.key,
                    equals: gate.equals,
                    match:  gate.match
                }));
            }
            if (gate.tick) {
                progress('waiting_contract_balance', { contractActionIndex: index, tick: gate.tick });
                result.contractBalance = await waiter.waitForContractBalance(index, gate.tick,
                    Object.assign({}, waitOpts, { minQuantity: gate.minQuantity }));
            }
        } catch (err) {
            // Same reasoning as the indexer-wait timeout: the transaction IS
            // broadcast, so this is "not executed yet", never "not sent". A
            // caller that rebuilds on this error double-spends its own inputs.
            if (err && (err.code === 'CONTRACT_STATE_TIMEOUT' || err.code === 'CONTRACT_BALANCE_TIMEOUT')) {
                err.broadcast = true;
                err.txid      = finalTxid;
                if (err.details && typeof err.details === 'object') {
                    err.details.broadcast = true;
                    err.details.txid      = finalTxid;
                }
            }
            throw err;
        }

        progress('contract_settled', {
            contractActionIndex: index,
            state:   result.contractState   || null,
            balance: result.contractBalance || null
        });
    },

    // Extract input references from an unsigned PSBT hex for UTXO cache tracking
    // The bitcoinjs network the reconcile gate parses submitted addresses against.
    // Undefined (bitcoinjs default) when the SDK was built without one: an address
    // that then fails to parse authorizes nothing, so the gate stays fail-closed.
    _reconcileNetwork() {
        try { return this.sdk.wallet.getBitcoinNetwork(); }
        catch (e) { return undefined; }
    },

    // Outputs of one BROADCAST transaction that pay back to the caller's own
    // change destination, shaped exactly as the encoder's validateUtxoEntry
    // demands (txid, vout, value, scriptPubKey, confirmations), so the caller
    // can hand them straight back into createTx({ utxos }). confirmations is 0
    // by construction: the transaction is on the wire, not in a block, and the
    // encoder only keeps a zero-confirmation input when unconfirmed is left at
    // its default true.
    //
    // Reads the SIGNED tx hex rather than the PSBT, because a chained spend
    // needs the real txid, which only exists once the inputs are final.
    _extractChangeOutputs(txHex, changeAddress) {
        if (!txHex || !changeAddress) return [];
        try {
            const bitcoin = require('bitcoinjs-lib');
            // Compare SCRIPTS, not decoded addresses. address.fromOutputScript
            // throws on every non-standard output a transaction here carries
            // (the OP_RETURN carrier, the bare-multisig data outputs, a P2SH
            // chunk leg), and one throw mid-loop would lose the change output
            // too. Encoding the change address once and matching bytes has
            // neither problem, and it silently ignores an address the network
            // cannot parse (a hex pubkey passed as `pubkey`), which is the
            // fail-closed answer: no change tracked, same as before.
            let changeScript = bitcoin.address
                .toOutputScript(changeAddress, this._reconcileNetwork())
                .toString('hex');
            let tx   = bitcoin.Transaction.fromHex(txHex);
            let txid = tx.getId();
            let outs = [];
            for (let vout = 0; vout < tx.outs.length; vout++) {
                let script = Buffer.from(tx.outs[vout].script).toString('hex');
                if (script !== changeScript) continue;
                // applyBufferutilsPatch hands back a value above 2^53-1 (a large
                // DOGE change output) as a BigInt, which JSON.stringify refuses,
                // so this entry would kill the very createTx call it exists to
                // fund. Carry it as the exact decimal STRING the tracker itself
                // emits and the encoder's parseSatoshiAmount already accepts.
                let value = tx.outs[vout].value;
                outs.push({
                    txid:          txid,
                    vout:          vout,
                    value:         (typeof value === 'bigint') ? value.toString() : value,
                    scriptPubKey:  script,
                    confirmations: 0
                });
            }
            return outs;
        } catch (e) {
            return [];
        }
    },

    _extractSpentInputs(psbtHex) {
        try {
            const bitcoin = require('bitcoinjs-lib');
            let psbt = bitcoin.Psbt.fromHex(psbtHex);
            return psbt.txInputs.map(input => ({
                txid: Buffer.from(input.hash).reverse().toString('hex'),
                vout: input.index
            }));
        } catch (e) {
            return [];
        }
    },
};
