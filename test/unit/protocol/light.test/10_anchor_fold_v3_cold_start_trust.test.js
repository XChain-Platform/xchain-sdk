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
 * XChain Platform SDK - ANCHOR v3 (fold) cold-start trust
 *
 * The hub emits v3 at/above ANCHOR_FOLD_ACTIVATION. These cases pin that the
 * fetch path admits a fold section only where the gate is active at the
 * anchor's DOGE height, and that the wrapper section verifies against the
 * archive-extended canonical its signers actually signed.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const light  = require('../../../../src/protocol/light_client.js');
const checkpoint = require('../../../../src/checkpoint.js');

const ENV = 'XC_ANCHOR_FOLD_REGTEST_ACTIVATION';
const NET = 'regtest';

async function withFold(value, fn) {
    const saved = process.env[ENV];
    try {
        if (value === undefined) delete process.env[ENV];
        else process.env[ENV] = value;
        return await fn();
    } finally {
        if (saved === undefined) delete process.env[ENV];
        else process.env[ENV] = saved;
    }
}

const signer = (() => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, pubkeyHex: spki.subarray(spki.length - 32).toString('hex') };
})();
const VALIDATORS = [{ pubkey: signer.pubkeyHex, source: signer.pubkeyHex, weight: '100' }];
const sign = (text) => crypto.sign(null, Buffer.from(text, 'utf8'), signer.privateKey).toString('hex');

function baseCp(chain, seq) {
    return {
        chain, network: NET, block_index: 100, block_hash: 'c0'.repeat(32),
        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: seq, snapshot_block: 100, state_root: 'd4'.repeat(32), state_root_version: 1,
        block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1,
    };
}

// One explorer section row, signed over the plain canonical, at a version and DOGE height.
function row(version, dogeBlock, seq = 7, chain = 'BTC') {
    const cp = baseCp(chain, seq);
    const sigs = [{ pubkey: signer.pubkeyHex, sig: sign(checkpoint.canonicalCheckpoint(cp)) }];
    return Object.assign({}, cp, { version, validator_signatures: JSON.stringify(sigs),
        block_index_doge: dogeBlock, tx_hash: 'dd'.repeat(32) });
}

function foldRow(dogeBlock) {
    const cp = Object.assign(baseCp('BTC', 7), { fold_archive: ARCHIVE });
    const sigs = [{ pubkey: signer.pubkeyHex, sig: sign(checkpoint.canonicalCheckpoint(cp)) }];
    return Object.assign({}, cp, ARCHIVE, { version: 3, fold_archive: undefined,
        validator_signatures: JSON.stringify(sigs), block_index_doge: dogeBlock,
        tx_hash: 'dd'.repeat(32) });
}

function fetchRows(...rows) {
    const fetchImpl = async (url) => url.includes('/api/anchors/')
        ? { ok: true, status: 200, json: async () => ({ data: rows }) }
        : { ok: false, status: 404, json: async () => ({}) };
    return (extra = {}) => light.fetchAnchoredCheckpoint(Object.assign({ explorerUrl: 'https://x', dogeCoin: 'DOGE',
        targetChain: 'BTC', validators: VALIDATORS, dogeTipHeight: 2500, minDepth: 60, fetchImpl }, extra));
}

describe('ANCHOR v3 fold: fetchAnchoredCheckpoint admits fold sections only past the gate', function () {
    beforeEach(function () { light.clearValidatorSetCache(); });

    it('verifies a v3 section at/above the fold height and refuses one below it', async function () {
        await withFold('1500', async () => {
            const ok = await fetchRows(row(3, 2000))();
            assert.strictEqual(ok.verified, true, ok.reason);
            assert.strictEqual((await fetchRows(row(3, 1000))()).reason, 'NO_ROOT_ANCHOR');
        });
    });

    it('verifies an explorer wrapper row signed over its folded archive fields', async function () {
        await withFold('1500', async () => {
            const result = await fetchRows(foldRow(2000))();
            assert.strictEqual(result.verified, true, result.reason);
            assert.deepStrictEqual(result.checkpoint.fold_archive, {
                match_batch_seq: 42, match_count: 17, batch_crc32: '9c4e1b22', total_chunks: 1
            });
        });
    });

    it('refuses every v3 row while the fold gate is unarmed, and v5 even when armed', async function () {
        await withFold(undefined, async () => {
            assert.strictEqual((await fetchRows(row(3, 2000))()).reason, 'NO_ROOT_ANCHOR');
        });
        await withFold('1500', async () => {
            assert.strictEqual((await fetchRows(row(5, 2000))()).reason, 'NO_ROOT_ANCHOR');
        });
    });

    it('picks the newest checkpoint across the flag day whichever version carries it', async function () {
        await withFold('1500', async () => {
            const forward = await fetchRows(row(0, 1200, 6), row(3, 2000, 7))();
            assert.strictEqual(forward.verified, true, forward.reason);
            assert.strictEqual(forward.checkpoint.checkpoint_seq, 7);
            const back = await fetchRows(row(0, 2100, 8), row(3, 2000, 7))();
            assert.strictEqual(back.checkpoint.checkpoint_seq, 8);
        });
    });

    it('re-judges the gate at the caller DOGE height over the explorer claim', async function () {
        await withFold('1500', async () => {
            const r = await fetchRows(row(3, 2000))({ dogeTxHeight: 1000 });
            assert.strictEqual(r.verified, false);
            assert.strictEqual(r.reason, 'ANCHOR_FOLD_NOT_ACTIVE');
            assert.strictEqual(r.depthSource, 'caller');
            const v0 = await fetchRows(row(0, 2000))({ dogeTxHeight: 1000 });
            assert.strictEqual(v0.verified, true, v0.reason);
        });
    });

    it('excludes a v3 row with no chain or no state root', async function () {
        await withFold('1500', async () => {
            const archiveRow = Object.assign(row(3, 2000), { chain: null });
            const rootless = Object.assign(row(3, 2000), { state_root: null });
            assert.strictEqual((await fetchRows(archiveRow, rootless)()).reason, 'NO_ROOT_ANCHOR');
        });
    });
});

// A v3 wire: BTC then DOGE, the wrapper (when ARCHIVE_COUNT is 1) at BTC, index 0.
const ARCHIVE = { match_batch_seq: 42, match_count: 17, batch_crc32: '9C4E1B22', total_chunks: 1 };

function sectionFields(cp, sig) {
    return [cp.chain, cp.block_index, cp.block_hash, cp.ledger_hash, cp.actions_hash, cp.contract_hash,
        cp.checkpoint_seq, cp.snapshot_block, cp.state_root, cp.state_root_version, cp.block_merkle_root,
        cp.block_merkle_version, 1, signer.pubkeyHex, sig];
}

function v3Wire({ archive = true, btcSignedOver, wireArchive = ARCHIVE } = {}) {
    const btc = baseCp('BTC', 7), doge = baseCp('DOGE', 7);
    const btcText = btcSignedOver || checkpoint.canonicalCheckpoint(Object.assign({ fold_archive: archive ? ARCHIVE : null }, btc));
    const parts = ['ANCHOR', '3', NET, 100, 2, ...sectionFields(btc, sign(btcText)),
        ...sectionFields(doge, sign(checkpoint.canonicalCheckpoint(doge))), archive ? 1 : 0];
    if (archive) parts.push(0, wireArchive.match_batch_seq, wireArchive.match_count, wireArchive.batch_crc32,
        wireArchive.total_chunks, 'H4sIAAAAAAAAAw==');
    parts.push('ab'.repeat(32), 0);
    return parts.join('|');
}

const verify = (wire, chain) => light.verifyAnchoredCheckpoint({
    checkpoint: light.anchorBundleSection(wire, chain), validators: VALIDATORS, confirmations: 1000 });

describe('ANCHOR v3 fold: the wrapper section verifies over the archive-extended canonical', function () {
    it('matches the hub foldArchiveCanonical bytes, written out by hand', function () {
        const raw = ['XCHECKPOINT', 'BTC', 'regtest', '100', 'c0'.repeat(32), 'a1'.repeat(32), 'b2'.repeat(32),
            'c3'.repeat(32), '7', '100', 'd4'.repeat(32), '1', 'e5'.repeat(32), '1', '42', '17', '9c4e1b22', '1'].join('|');
        const expected = 'EQUIV|XCHECKPOINT|BTC|regtest|100|7|42|0||' + raw;
        assert.strictEqual(checkpoint.canonicalCheckpoint(Object.assign({ fold_archive: ARCHIVE }, baseCp('BTC', 7))), expected);
    });

    it('tags only the wrapper section and verifies both sections', function () {
        const parsed = light.parseAnchorV3(v3Wire());
        assert.deepStrictEqual(parsed.sections[0].fold_archive,
            { match_batch_seq: 42, match_count: 17, batch_crc32: '9c4e1b22', total_chunks: 1 });
        assert.strictEqual(parsed.sections[1].fold_archive, undefined);
        assert.strictEqual(verify(v3Wire(), 'BTC').verified, true);
        assert.strictEqual(verify(v3Wire(), 'DOGE').verified, true);
    });

    it('refuses a wrapper signed over the plain canonical, with no fallback', function () {
        const plain = checkpoint.canonicalCheckpoint(baseCp('BTC', 7));
        assert.strictEqual(verify(v3Wire({ btcSignedOver: plain }), 'BTC').reason, 'CHECKPOINT_QUORUM_FAILED');
    });

    it('refuses a wrapper whose archive fields moved on the wire', function () {
        const moved = Object.assign({}, ARCHIVE, { match_count: 18 });
        assert.strictEqual(verify(v3Wire({ wireArchive: moved }), 'BTC').reason, 'CHECKPOINT_QUORUM_FAILED');
    });

    it('leaves an ARCHIVE_COUNT 0 bundle on the plain canonical', function () {
        const wire = v3Wire({ archive: false });
        assert.strictEqual(light.parseAnchorV3(wire).sections[0].fold_archive, undefined);
        assert.strictEqual(verify(wire, 'BTC').verified, true);
    });
});
