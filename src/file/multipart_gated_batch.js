const crypto = require('crypto');
const ecc = require('@bitcoinerlab/secp256k1');
const GatedFileUtils = require('../actions/gated_file.js');

function error(code, field, message) {
    let err = new Error(`${field}: ${message}`);
    err.code = code;
    return err;
}

function validateText(value, field) {
    if (typeof value !== 'string' || value.trim() === '')
        throw error('GATED_MANIFEST_INVALID', field, 'must be a non-empty string');
}

function publicKeyBytes(sourcePubkey) {
    if (Buffer.isBuffer(sourcePubkey)) return sourcePubkey;
    if (typeof sourcePubkey !== 'string' ||
        !/^(?:[0-9a-f]{66}|[0-9a-f]{130})$/i.test(sourcePubkey))
        throw error('INVALID_PUBKEY', 'sourcePubkey', 'must be a valid secp256k1 public key');
    return Buffer.from(sourcePubkey, 'hex');
}

function validatePublicKey(sourcePubkey) {
    let bytes = publicKeyBytes(sourcePubkey);
    if ((bytes.length !== 33 && bytes.length !== 65) || !ecc.isPoint(bytes))
        throw error('INVALID_PUBKEY', 'sourcePubkey', 'must be a valid secp256k1 public key');
}

function validateCommitInput({ key, coin, sourceAddress, sourcePubkey }) {
    if (!Buffer.isBuffer(key) || key.length !== GatedFileUtils.KEY_LEN)
        throw error('GATED_MANIFEST_INVALID', 'key', 'must be a 32-byte Buffer');
    validateText(coin, 'coin');
    validateText(sourceAddress, 'sourceAddress');
    validatePublicKey(sourcePubkey);
}

function validateManifest(manifestParams, key) {
    let params = manifestParams && typeof manifestParams === 'object' ? manifestParams : {};
    if (Object.prototype.hasOwnProperty.call(params, 'rawData'))
        throw error('GATED_MANIFEST_INVALID', 'rawData', 'manifest carries no bytes');
    validateText(params.gateTicker, 'gateTicker');
    if (typeof params.keyHash !== 'string' || !/^[0-9a-f]{64}$/i.test(params.keyHash))
        throw error('GATED_MANIFEST_INVALID', 'keyHash', 'must be 64 hexadecimal characters');
    let actual = crypto.createHash('sha256').update(key).digest('hex');
    if (actual !== params.keyHash.toLowerCase())
        throw error('GATED_KEY_MISMATCH', 'keyHash', 'does not match key');
}

function keyCommitMessageParams(input, messaging) {
    validateCommitInput(input);
    if (!messaging || typeof messaging.eciesEncryptBytes !== 'function')
        throw error('GATED_MANIFEST_INVALID', 'messaging', 'must provide eciesEncryptBytes');
    let payload = new GatedFileUtils().serializeKeyPayload([input.key]);
    let encryptedMessage = messaging.eciesEncryptBytes(payload, input.sourcePubkey).ciphertext;
    return {
        coin: input.coin.toUpperCase(),
        destination: input.sourceAddress,
        encryptedMessage
    };
}

function gatedManifestBatchEntries(input, messaging) {
    validateCommitInput(input);
    validateManifest(input.manifestParams, input.key);
    let commit = keyCommitMessageParams(input, messaging);
    return [
        { action: 'FILE', params: input.manifestParams },
        { action: 'MESSAGE', params: commit }
    ];
}

module.exports = { keyCommitMessageParams, gatedManifestBatchEntries };
