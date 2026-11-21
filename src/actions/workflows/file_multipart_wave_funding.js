/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 ********************************************************************/

'use strict';

// Wave funding for publishMultipartFile: per-piece output values, the funding
// transaction for one wave (chained from the previous wave's change), and the
// wait for its confirmation. Split from file_multipart_publish.js to keep that
// workflow under the CODE-STYLE.md file length limit; behaviour is unchanged.

function baseCoin(sdk, opts) {
    if (opts.coin) return String(opts.coin).toUpperCase();
    const coin = String(sdk.requireExplorer().coin || '').toUpperCase();
    return coin.replace(/^[RT](?=BTC$|LTC$|DOGE$)/, '');
}

function valueAt(value, descriptor, position) {
    if (typeof value === 'function') return value(descriptor, position);
    if (Array.isArray(value)) return value[position];
    return value;
}

function pairSizeOf(piece, source, opts, position) {
    const quote = opts.quote || opts;
    const sizes = quote.sizes || opts.sizes || quote;
    if (typeof sizes.pairSizeFor === 'function')
        return sizes.pairSizeFor({ ...piece, lane: source.lane }, position);
    const named = source.lane === 'envelope'
        ? sizes.envelopePairVbytes : sizes.standardPairBytes;
    const size = valueAt(named === undefined ? sizes.pairSize : named, piece, position);
    if (!Number.isFinite(size) || size < 0)
        throw new Error('publishMultipartFile requires a finite multipart pair size quote');
    return size;
}

// Relay-policy output floor per coin when the quote carries none. Mirrors
// SOFT_DUST_FLOOR_BY_COIN in the encoder's constants; a parity test holds the two
// together wherever both checkouts are present.
const SOFT_DUST_FLOOR_BY_COIN = Object.freeze({ DOGE: 1000000 });

function outputFloorOf(sdk, opts) {
    const quote = opts.quote || opts;
    if (Number.isFinite(quote.outputFloor) && quote.outputFloor >= 0) return quote.outputFloor;
    const soft = SOFT_DUST_FLOOR_BY_COIN[baseCoin(sdk, opts)];
    if (soft !== undefined) return soft;
    return sdk.wallet.getBitcoinNetwork().dustThreshold;
}

async function feeRateOf(encoder, opts) {
    const quote = opts.quote || opts;
    if (Number.isFinite(quote.rate) && quote.rate > 0) return quote.rate;
    const fees = await encoder.getFeeTiers();
    const rate = Number(fees && fees.high);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error('encoder returned no high fee rate');
    return rate;
}

function fundingValues(sdk, pieces, source, rate, opts, modules) {
    const quote = opts.quote || opts;
    const supplied = quote.pieceFundingValues || quote.pieceValues || quote.outputs;
    if (Array.isArray(supplied)) {
        const values = supplied.map(item => item && typeof item === 'object' ? item.value : item);
        if (values.length === pieces.length) return values;
        if (pieces.every(piece => piece.fundingIndex < values.length))
            return pieces.map(piece => values[piece.fundingIndex]);
        throw new Error('multipart funding values do not cover every piece being sent');
    }
    const outputFloor = outputFloorOf(sdk, opts);
    // Litecoin's stripped-size floor makes the encoder pad the envelope reveal.
    const revealPad = baseCoin(sdk, opts) === 'LTC';
    return pieces.map((piece, index) => modules.pieceFundingValue({
        lane: source.lane,
        rate,
        pairSize: pairSizeOf(piece, source, opts, index),
        outputFloor,
        payloadBytes: piece.payloadBytes,
        revealPad,
    }));
}

function fundingOutputsFromPsbt(sdk, psbt) {
    return sdk.wallet.decomposePsbt(psbt).outputs.map((output, vout) => ({
        vout,
        value: output.value,
        address: output.address,
        scriptPubKey: output.scriptPubKeyHex,
    }));
}

function fundingChange(outputs, utxos, txid, sourceAddress) {
    const pieceVouts = new Set(utxos.map(utxo => utxo.vout));
    const output = outputs.find(item => !pieceVouts.has(item.vout)
        && item.address === sourceAddress);
    return output ? { ...output, txid } : null;
}

async function waitForFunding(encoder, txid, opts) {
    if (typeof opts.waitForFunding === 'function') return opts.waitForFunding(txid);
    const timeout = opts.timeout > 0 ? opts.timeout : 120000;
    const interval = opts.pollInterval > 0 ? opts.pollInterval : 2000;
    const deadline = Date.now() + timeout;
    do {
        const block = await encoder.getTxBlock(txid);
        if (block) return block;
        const remaining = deadline - Date.now();
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, Math.min(interval, remaining)));
    } while (Date.now() < deadline);
    const error = new Error('Multipart funding transaction was not confirmed in time');
    error.code = 'FUNDING_CONFIRMATION_TIMEOUT';
    throw error;
}

// The caller's per-transaction fee ceiling covers the funding transaction too;
// maxFundingFeeSats overrides it for a wave whose many outputs need a higher one.
function fundingFeeCap(opts) {
    return opts.maxFundingFeeSats != null ? opts.maxFundingFeeSats : opts.maxFeeSats;
}

async function fundPieces(sdk, wave, previousFunding, source, rate, opts, modules, progress) {
    const pieces = wave.pieces;
    const previousChange = previousFunding && previousFunding.change;
    if (!pieces.length) return null;
    const encoder = sdk.requireEncoder();
    const values = fundingValues(sdk, pieces, source, rate, opts, modules);
    const expected = modules.multipartFundingOutputs(values, source.sourceAddress).customOutputs;
    // The encoder picks UTXOs from `pubkey`; the address keeps a P2PKH owner's source exact.
    const request = { pubkey: source.sourceAddress || source.pubkey,
        sourceAddress: source.sourceAddress, change: source.sourceAddress,
        customOutputs: expected, feePerKb: rate * 1000 };
    if (previousChange) request.utxos = [previousChange];
    const encoded = await encoder.createTx(request);
    const network = sdk.wallet.getBitcoinNetwork();
    modules.reconcileEncoded(encoded.psbt, { network,
        customOutputs: expected, changeAddresses: source.sourceAddress,
        callerIdentities: source.pubkey, maxFeeSats: fundingFeeCap(opts),
        // reconcileEncoded reads input values as BigInt and matches a leg with ===.
        requiredSpends: previousChange ? [{ script: Buffer.from(previousChange.scriptPubKey, 'hex'), value: BigInt(previousChange.value) }] : [],
        trustedPrevTxs: previousFunding ? [previousFunding.signed.txHex] : [],
        label: 'multipart funding', phaseShapes: [], phaseSpends: null });
    modules.assertNoActionCarrier({ psbt: encoded.psbt, network, label: 'multipart funding' });
    const outputs = fundingOutputsFromPsbt(sdk, encoded.psbt);
    const utxos = modules.matchFundingOutputs(expected, outputs, null);
    const signed = sdk.wallet.signPsbt(encoded.psbt, opts.wif);
    utxos.forEach(utxo => { utxo.txid = signed.txid; });
    await encoder.broadcastTx(signed.txHex);
    progress.emit('funding_sent', { txid: signed.txid });
    const confirmed = await waitForFunding(encoder, signed.txid, opts);
    progress.emit('funding_confirmed', { txid: signed.txid, block: confirmed });
    progress.emit('wave_funded', { wave: wave.index + 1, waves: wave.total,
        txid: signed.txid, block: confirmed });
    const change = fundingChange(outputs, utxos, signed.txid, source.sourceAddress);
    return { txid: signed.txid, signed, confirmed, expectedOutputs: expected, utxos, change };
}

module.exports = { baseCoin, feeRateOf, fundPieces, outputFloorOf, SOFT_DUST_FLOOR_BY_COIN };
