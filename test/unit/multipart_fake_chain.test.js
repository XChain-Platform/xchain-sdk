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

const { expect } = require('chai');
const { SDKExplorerError } = require('../../src/utils/errors.js');
const { createFakeMultipartChain } = require('../helpers/multipart_fake_chain.js');

const RAW = {
    fileHash: '94d17c51c075eff21c1553f699074c8a136b2e2b87d9bd9b10dfe9d4c2fa6827',
    totalParts: 2,
    totalBytes: 20,
    parts: [
        Buffer.from('6d756c746970617274', 'hex'),
        Buffer.from('2072617720766563746f72', 'hex'),
    ],
};
const MISMATCH = {
    fileHash: '023359fd0527dded204b9aa3dda9a5b4b2c07706ad88ce7edbf4f257323f09bb',
    totalParts: 2,
    totalBytes: 17,
    parts: [
        Buffer.from('6d69736d617463682d', 'hex'),
        Buffer.from('6578706563746565', 'hex'),
    ],
};

function manifest(chain, vector, txid = 'manifest', source = 'alice', state = 'confirmed') {
    return chain.addPiece({ kind: 'manifest', source, txid, state, ...vector, parts: undefined });
}

function part(chain, vector, partIndex, txid, source = 'alice', state = 'confirmed', rawData) {
    return chain.addPiece({
        kind: 'part', source, txid, state, fileHash: vector.fileHash,
        partIndex, rawData: rawData || vector.parts[partIndex],
    });
}

function bodyOf(error) {
    return JSON.parse(error.details.data.toString('utf8'));
}

async function caught(promise) {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('Expected promise to reject');
}

describe('multipart fake chain ordering', function () {
    it('completes when parts arrive before the manifest', async function () {
        const chain = createFakeMultipartChain();
        part(chain, RAW, 1, 'part-1');
        part(chain, RAW, 0, 'part-0');
        const added = manifest(chain, RAW);
        const detail = (await chain.explorer().getAction(added.actionIndex)).data[0];
        expect(detail.multipart).to.deep.equal({
            file_hash: RAW.fileHash, total_parts: 2, parts_received: 2,
            total_bytes: 20, status: 'complete',
        });
        expect(await chain.explorer().getGatedFileRaw(added.actionIndex))
            .to.deep.equal(Buffer.concat(RAW.parts));
    });

    it('moves a manifest-first assembly from pending to complete', async function () {
        const chain = createFakeMultipartChain();
        const added = manifest(chain, RAW);
        part(chain, RAW, 0, 'part-0');
        let detail = (await chain.explorer().getAction(added.actionIndex)).data[0];
        expect(detail.multipart).to.include({ parts_received: 1, status: 'pending' });
        part(chain, RAW, 1, 'part-1');
        detail = (await chain.explorer().getAction(added.actionIndex)).data[0];
        expect(detail.multipart).to.include({ parts_received: 2, status: 'complete' });
    });
});

describe('multipart fake chain winner selection', function () {
    it('uses the lowest part index action and ignores high and foreign parts', async function () {
        const chain = createFakeMultipartChain();
        const added = manifest(chain, RAW);
        part(chain, RAW, 0, 'part-0');
        part(chain, RAW, 0, 'part-0-duplicate', 'alice', 'confirmed', Buffer.from('wrong'));
        part(chain, RAW, 3, 'part-high', 'alice', 'confirmed', Buffer.from('ignored'));
        part(chain, RAW, 1, 'part-foreign', 'bob');
        let detail = (await chain.explorer().getAction(added.actionIndex)).data[0];
        expect(detail.multipart).to.include({ parts_received: 1, status: 'pending' });
        part(chain, RAW, 1, 'part-1');
        detail = (await chain.explorer().getAction(added.actionIndex)).data[0];
        expect(detail.multipart).to.include({ parts_received: 2, status: 'complete' });
    });

    it('links parts only after the valid manifest is indexed', async function () {
        const chain = createFakeMultipartChain();
        const addedPart = part(chain, RAW, 0, 'part-0');
        let detail = (await chain.explorer().getAction(addedPart.actionIndex)).data[0];
        expect(detail.file_part.manifest_action_index).to.equal(null);
        const addedManifest = manifest(chain, RAW);
        detail = (await chain.explorer().getAction(addedPart.actionIndex)).data[0];
        expect(detail.file_part.manifest_action_index).to.equal(addedManifest.actionIndex);
    });
});

describe('multipart fake chain transaction lifecycle', function () {
    it('does not count a mempool piece until mining assigns its index', async function () {
        const chain = createFakeMultipartChain();
        const addedManifest = manifest(chain, RAW);
        part(chain, RAW, 0, 'part-0');
        const waiting = part(chain, RAW, 1, 'part-1', 'alice', 'mempool');
        expect(waiting.actionIndex).to.equal(null);
        expect(chain.txState('part-1')).to.equal('mempool');
        let detail = (await chain.explorer().getAction(addedManifest.actionIndex)).data[0];
        expect(detail.multipart).to.include({ parts_received: 1, status: 'pending' });
        const mined = chain.mine();
        expect(mined).to.deep.equal([{ txid: 'part-1', actionIndex: 2 }]);
        detail = (await chain.explorer().getAction(addedManifest.actionIndex)).data[0];
        expect(detail.multipart).to.include({ parts_received: 2, status: 'complete' });
    });

    it('returns an empty action read before a future index is assigned', async function () {
        const chain = createFakeMultipartChain();
        const waiting = part(chain, RAW, 0, 'part-0', 'alice', 'mempool');
        expect(waiting.actionIndex).to.equal(null);
        expect(await chain.explorer().getAction(0)).to.deep.equal({ data: [] });
        chain.mine();
        expect((await chain.explorer().getAction(0)).data[0].tx_hash).to.equal('part-0');
    });

    it('keeps a dropped txid out of mining and source state', async function () {
        const chain = createFakeMultipartChain();
        part(chain, RAW, 0, 'part-0', 'alice', 'mempool');
        chain.drop('part-0');
        expect(chain.txState('part-0')).to.equal('dropped');
        expect(chain.txState('never-seen')).to.equal(null);
        expect(chain.actionIndexOf('part-0')).to.equal(null);
        expect(chain.mine()).to.deep.equal([]);
        expect(chain.piecesFor('alice')).to.have.length(1);
        expect(await chain.explorer().getAction(0)).to.deep.equal({ data: [] });
    });

    it('returns an empty read for a dropped assigned action slot', async function () {
        const chain = createFakeMultipartChain();
        const dropped = part(chain, RAW, 0, 'part-0');
        part(chain, RAW, 1, 'part-1');
        chain.drop('part-0');
        expect(chain.txState('part-0')).to.equal('dropped');
        expect(chain.actionIndexOf('part-0')).to.equal(null);
        expect(await chain.explorer().getAction(dropped.actionIndex)).to.deep.equal({ data: [] });
    });
});

describe('multipart fake chain raw reads', function () {
    it('returns transport-shaped incomplete and part errors', async function () {
        const chain = createFakeMultipartChain();
        const addedManifest = manifest(chain, RAW);
        const addedPart = part(chain, RAW, 0, 'part-0');
        const incomplete = await caught(chain.explorer().getGatedFileRaw(addedManifest.actionIndex));
        expect(incomplete).to.be.instanceof(SDKExplorerError);
        expect(incomplete.code).to.equal('EXPLORER_HTTP_409');
        expect(incomplete.details).to.include({ status: 409, url: '/file/0/raw' });
        expect(bodyOf(incomplete)).to.deep.equal({
            error: 'File is incomplete', code: 'FILE_INCOMPLETE',
            parts_received: 1, total_parts: 2,
        });
        const direct = await caught(chain.explorer().getGatedFileRaw(addedPart.actionIndex));
        expect(direct.code).to.equal('EXPLORER_HTTP_404');
        expect(bodyOf(direct).code).to.equal('FILE_PART');
    });

    it('returns mismatch and keeps it terminal after a later part', async function () {
        const chain = createFakeMultipartChain();
        const added = manifest(chain, MISMATCH);
        part(chain, MISMATCH, 0, 'part-0');
        part(chain, MISMATCH, 1, 'part-bad');
        let detail = (await chain.explorer().getAction(added.actionIndex)).data[0];
        expect(detail.multipart.status).to.equal('mismatch');
        part(chain, MISMATCH, 1, 'part-good', 'alice', 'confirmed', Buffer.from('expected'));
        detail = (await chain.explorer().getAction(added.actionIndex)).data[0];
        expect(detail.multipart.status).to.equal('mismatch');
        const error = await caught(chain.explorer().getGatedFileRaw(added.actionIndex));
        expect(error.code).to.equal('EXPLORER_HTTP_422');
        expect(bodyOf(error)).to.deep.equal({
            error: 'File assembly does not match the manifest', code: 'FILE_ASSEMBLY_MISMATCH',
        });
    });
});

describe('multipart fake chain manifests', function () {
    it('marks a second source and hash manifest invalid without multipart data', async function () {
        const chain = createFakeMultipartChain();
        manifest(chain, RAW, 'manifest-1');
        const duplicate = manifest(chain, RAW, 'manifest-2');
        const detail = (await chain.explorer().getAction(duplicate.actionIndex)).data[0];
        expect(detail.status).to.equal('invalid: FILE_HASH (duplicate manifest)');
        expect(detail).not.to.have.property('multipart');
    });
});

describe('multipart fake chain network reads and calls', function () {
    it('returns newest status, descending blocks, and every adapter call', async function () {
        const chain = createFakeMultipartChain({ blockTimes: [100, 200, 300] });
        const explorer = chain.explorer();
        expect(await explorer.getStatus()).to.deep.equal({ last_block_time: 300 });
        expect(await explorer.get('/blocks', { limit: 2, sortorder: 'desc' })).to.deep.equal({
            data: [
                { block_index: 2, block_time: 300 },
                { block_index: 1, block_time: 200 },
            ],
        });
        expect(await explorer.getAction(12)).to.deep.equal({ data: [] });
        expect(chain.calls).to.deep.equal([
            { method: 'getStatus', args: [] },
            { method: 'get', args: ['/blocks', { limit: 2, sortorder: 'desc' }] },
            { method: 'getAction', args: [12] },
        ]);
    });
});
