// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const crypto = require('crypto');

const DIGEST_PATTERN = /^[0-9a-f]{64}$/i;

function resumeError(code, message) {
    const error = new Error(`${code}: ${message}`);
    error.code = code;
    return error;
}

function matchPickedFile(records, originalSha256) {
    if (typeof originalSha256 !== 'string' || !DIGEST_PATTERN.test(originalSha256)) {
        throw resumeError('RESUME_BAD_DIGEST', 'originalSha256 must be a 64-character hex digest');
    }

    const wanted = originalSha256.toLowerCase();
    return records.find((record) => (
        typeof record.originalSha256 === 'string'
        && record.originalSha256.toLowerCase() === wanted
    )) || null;
}

function confirmResumePlan(record, plan) {
    if (!record) return false;
    if (record.fileHash !== plan.fileHash) {
        throw resumeError(
            'RESUME_PLAN_MISMATCH',
            `stored fileHash ${record.fileHash} does not match planned fileHash ${plan.fileHash}`
        );
    }
    return record.totalParts === plan.totalParts;
}

function fileHashOfDigests(partDigests) {
    const digestBytes = partDigests.map((digest) => Buffer.from(digest, 'hex'));
    return crypto.createHash('sha256').update(Buffer.concat(digestBytes)).digest('hex');
}

function winningParts(onChainPieces, fileHash, totalParts) {
    const winners = new Map();
    for (const piece of onChainPieces) {
        if (piece.kind !== 'part' || piece.fileHash !== fileHash) continue;
        if (!Number.isInteger(piece.partIndex) || piece.partIndex < 0) continue;
        if (piece.partIndex >= totalParts) continue;
        const winner = winners.get(piece.partIndex);
        if (!winner || piece.actionIndex < winner.actionIndex) {
            winners.set(piece.partIndex, piece);
        }
    }
    return winners;
}

function piecesToSend(plan, onChainPieces) {
    const fileHash = fileHashOfDigests(plan.partDigests);
    const winners = winningParts(onChainPieces, fileHash, plan.totalParts);
    const missingParts = [];
    const conflicting = [];

    for (let partIndex = 0; partIndex < plan.totalParts; partIndex += 1) {
        const winner = winners.get(partIndex);
        if (!winner) missingParts.push(partIndex);
        else if (winner.partDigest !== plan.partDigests[partIndex]) conflicting.push(winner);
    }

    return {
        manifestSent: onChainPieces.some((piece) => (
            piece.kind === 'manifest' && piece.fileHash === fileHash
        )),
        missingParts,
        conflicting
    };
}

module.exports = { matchPickedFile, confirmResumePlan, piecesToSend };
