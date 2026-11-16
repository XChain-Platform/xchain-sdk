/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/
'use strict';

const crypto = require('crypto');
const { SDKExplorerError } = require('../../src/utils/errors.js');

function digest(bytes) {
    return crypto.createHash('sha256').update(bytes).digest();
}

function groupKey(piece) {
    return piece.source + '\0' + piece.fileHash;
}

function indexedPieces(model) {
    return model.pieces.filter((piece) => piece.state === 'confirmed' && piece.actionIndex !== null);
}

function validManifest(model, source, fileHash) {
    return indexedPieces(model)
        .filter((piece) => piece.kind === 'manifest' && piece.source === source && piece.fileHash === fileHash)
        .sort((left, right) => left.actionIndex - right.actionIndex)[0] || null;
}

function winningParts(model, manifest) {
    const winners = new Map();
    indexedPieces(model)
        .filter((piece) => piece.kind === 'part' && piece.source === manifest.source &&
            piece.fileHash === manifest.fileHash && piece.partIndex >= 0 &&
            piece.partIndex < manifest.totalParts)
        .sort((left, right) => left.actionIndex - right.actionIndex)
        .forEach((piece) => {
            if (!winners.has(piece.partIndex)) winners.set(piece.partIndex, piece);
        });
    return winners;
}

function assembly(model, manifest) {
    const winners = winningParts(model, manifest);
    const frozen = model.terminals.get(groupKey(manifest));
    if (frozen) return { status: frozen, winners };
    if (winners.size !== manifest.totalParts) return { status: 'pending', winners };
    const ordered = Array.from({ length: manifest.totalParts }, (_, index) => winners.get(index));
    const bytes = ordered.reduce((sum, piece) => sum + piece.rawData.length, 0);
    const hashes = Buffer.concat(ordered.map((piece) => digest(piece.rawData)));
    const status = digest(hashes).toString('hex') === manifest.fileHash && bytes === manifest.totalBytes
        ? 'complete' : 'mismatch';
    return { status, winners };
}

function settle(model, piece) {
    const manifest = validManifest(model, piece.source, piece.fileHash);
    if (!manifest || model.terminals.has(groupKey(manifest))) return;
    const result = assembly(model, manifest);
    if (result.status !== 'pending') model.terminals.set(groupKey(manifest), result.status);
}

function multipartDetail(model, manifest) {
    const result = assembly(model, manifest);
    return {
        file_hash: manifest.fileHash,
        total_parts: manifest.totalParts,
        parts_received: result.winners.size,
        total_bytes: manifest.totalBytes,
        status: result.status,
    };
}

function detailFor(model, piece) {
    const base = {
        action: 'FILE',
        action_format: piece.kind === 'manifest' ? 1 : 2,
        action_index: piece.actionIndex,
        tx_hash: piece.txid,
        source: piece.source,
        status: 'valid',
    };
    const manifest = validManifest(model, piece.source, piece.fileHash);
    if (piece.kind === 'manifest' && manifest !== piece)
        return { ...base, status: 'invalid: FILE_HASH (duplicate manifest)' };
    if (piece.kind === 'manifest') return { ...base, multipart: multipartDetail(model, piece) };
    return {
        ...base,
        file_part: {
            file_hash: piece.fileHash,
            part_index: piece.partIndex,
            manifest_action_index: manifest ? manifest.actionIndex : null,
        },
    };
}

function rawError(status, index, body) {
    const url = '/file/' + index + '/raw';
    const data = Buffer.from(JSON.stringify(body));
    return new SDKExplorerError(
        'EXPLORER_HTTP_' + status,
        'Explorer returned HTTP ' + status + ' for ' + url,
        { url, status, data }
    );
}

function rawFor(model, index) {
    const piece = indexedPieces(model).find((entry) => entry.actionIndex === index);
    if (!piece) throw rawError(404, index, { error: 'Not found', code: 'NOT_FOUND' });
    if (piece.kind === 'part')
        throw rawError(404, index, { error: 'File parts cannot be served directly', code: 'FILE_PART' });
    if (validManifest(model, piece.source, piece.fileHash) !== piece)
        throw rawError(404, index, { error: 'Not found', code: 'NOT_FOUND' });
    const result = assembly(model, piece);
    if (result.status === 'pending') {
        throw rawError(409, index, {
            error: 'File is incomplete',
            code: 'FILE_INCOMPLETE',
            parts_received: result.winners.size,
            total_parts: piece.totalParts,
        });
    }
    if (result.status === 'mismatch')
        throw rawError(422, index, { error: 'File assembly does not match the manifest', code: 'FILE_ASSEMBLY_MISMATCH' });
    const ordered = Array.from({ length: piece.totalParts }, (_, partIndex) => result.winners.get(partIndex));
    return Buffer.concat(ordered.map((part) => part.rawData));
}

function indexPiece(model, piece) {
    piece.state = 'confirmed';
    piece.actionIndex = model.nextActionIndex++;
    settle(model, piece);
    return piece.actionIndex;
}

function addPiece(model, input) {
    const piece = {
        kind: input.kind,
        source: input.source,
        fileHash: input.fileHash,
        totalParts: input.totalParts,
        totalBytes: input.totalBytes,
        partIndex: input.partIndex,
        rawData: input.rawData === undefined ? null : Buffer.from(input.rawData),
        txid: input.txid,
        state: input.state || 'confirmed',
        actionIndex: null,
        insertion: model.nextInsertion++,
    };
    model.pieces.push(piece);
    if (piece.state === 'confirmed') indexPiece(model, piece);
    return { txid: piece.txid, actionIndex: piece.actionIndex };
}

function blocksFor(blockTimes, opts) {
    const rows = blockTimes.map((blockTime, blockIndex) => ({
        block_index: blockIndex,
        block_time: blockTime,
    })).reverse();
    return rows.slice(0, opts.limit === undefined ? rows.length : opts.limit);
}

function createExplorer(model, blockTimes, calls) {
    return {
        async getAction(index) {
            calls.push({ method: 'getAction', args: [index] });
            const piece = indexedPieces(model).find((entry) => entry.actionIndex === index);
            return { data: piece ? [detailFor(model, piece)] : [] };
        },
        async getStatus() {
            calls.push({ method: 'getStatus', args: [] });
            return { last_block_time: blockTimes.length ? blockTimes[blockTimes.length - 1] : null };
        },
        async get(path, opts = {}) {
            calls.push({ method: 'get', args: [path, { ...opts }] });
            if (path !== '/blocks') throw new Error('Unsupported fake explorer path: ' + path);
            return { data: blocksFor(blockTimes, opts) };
        },
        async getGatedFileRaw(index) {
            calls.push({ method: 'getGatedFileRaw', args: [index] });
            return rawFor(model, index);
        },
    };
}

function createFakeMultipartChain({ blockTimes = [] } = {}) {
    const model = { pieces: [], terminals: new Map(), nextActionIndex: 0, nextInsertion: 0 };
    const calls = [];
    return {
        calls,
        addPiece(input) {
            return addPiece(model, input);
        },
        mine() {
            return model.pieces
                .filter((piece) => piece.state === 'mempool')
                .sort((left, right) => left.insertion - right.insertion)
                .map((piece) => ({ txid: piece.txid, actionIndex: indexPiece(model, piece) }));
        },
        drop(txid) {
            const piece = model.pieces.find((entry) => entry.txid === txid);
            if (piece) {
                piece.state = 'dropped';
                piece.actionIndex = null;
            }
        },
        txState(txid) {
            const piece = model.pieces.find((entry) => entry.txid === txid);
            return piece ? piece.state : null;
        },
        actionIndexOf(txid) {
            const piece = model.pieces.find((entry) => entry.txid === txid);
            return piece && piece.state === 'confirmed' ? piece.actionIndex : null;
        },
        piecesFor(source) {
            return model.pieces.filter((piece) => piece.source === source).map((piece) => ({ ...piece }));
        },
        explorer() {
            return createExplorer(model, blockTimes.slice(), calls);
        },
    };
}

module.exports = { createFakeMultipartChain };
