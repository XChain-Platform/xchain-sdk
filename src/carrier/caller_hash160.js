'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const bitcoin = require('bitcoinjs-lib');

// Mirrors the encoder's resolveCallerHash160 rules. Identity parsing is kept
// independent of a configured network because the encoded address carries the
// version or witness program needed to recover the hash.
function callerHash160(identity) {
    if (typeof identity !== 'string' || !identity.trim()) return null;
    const text = identity.trim();
    try {
        if (/^(02|03)[0-9a-f]{64}$/i.test(text) || /^04[0-9a-f]{128}$/i.test(text))
            return Buffer.from(bitcoin.crypto.hash160(Buffer.from(text, 'hex')));
        try {
            const decoded = bitcoin.address.fromBase58Check(text);
            return decoded.hash.length === 20 ? Buffer.from(decoded.hash) : null;
        } catch (e) { /* try bech32 below */ }
        const decoded = bitcoin.address.fromBech32(text);
        return decoded.version === 0 && decoded.data.length === 20 ? Buffer.from(decoded.data) : null;
    } catch (e) {
        return null;
    }
}

function callerHash160s(identities) {
    const values = Array.isArray(identities) ? identities : [identities];
    const unique = new Map();
    for (const identity of values) {
        const hash = callerHash160(identity);
        if (hash) unique.set(hash.toString('hex'), hash);
    }
    return [...unique.values()];
}

module.exports = { callerHash160, callerHash160s };
