/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * SPV light client (Phase 4) round-trip unit tests.
 *
 * Builds REAL balance + action proofs with the sdk merkle.js twin (the same
 * module the indexer commits with and the explorer serves with), then asserts:
 *   - the pure verifiers ACCEPT a valid proof (membership, non-inclusion, action),
 *   - they REJECT forged proofs (wrong amount, wrong key, swapped root, bad leaf),
 *   - the network verifyBalance path integrates quorum + binding end-to-end against
 *     a REAL Ed25519-signed checkpoint, with a mocked fetch (no server).
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const M      = require('../../../../src/merkle.js');
const light  = require('../../../../src/protocol/light_client.js');
const checkpoint = require('../../../../src/checkpoint.js');

// The AUTHORITATIVE ANCHOR wire vector lives in the docs repo (hub and indexer
// vendor byte-identical copies; the SDK reads the original rather than adding a
// fourth copy to keep in sync). Resolved exactly as the other cross-repo guards
// resolve their siblings, so a single-repo clone skips instead of failing, and
// XCHAIN_REQUIRE_SIBLINGS=1 turns that silence into a failure.
const SIBLING_ROOT = process.env.XCHAIN_SIBLING_ROOT || path.join(__dirname, '../..', '..', '..', '..');
const DOCS_DIR     = process.env.XCHAIN_DOCS_DIR || process.env.XCHAIN_DOCUMENTATION_DIR
                     || path.join(SIBLING_ROOT, 'xchain-documentation');
const VECTOR_FILE  = path.join(DOCS_DIR, 'protocol', 'test-vectors', 'anchor_canonical.json');

function missingSibling(what) {
    if (process.env.XCHAIN_REQUIRE_SIBLINGS === '1')
        throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but ' + what + ' was not found');
    return null;
}

const CHAIN = 'BTC', NET = 'regtest', COIN = 'RBTC', TICK = 'XCHAIN';
const ADDR_A = '1AddrAaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADDR_Z = '1AddrZzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';
const EMPTY0_HEX = M.toHex(M.EMPTY[0]);
const EMPTY_ROOT = M.toHex(M.EMPTY[M.SMT_DEPTH]);


function makeSigner() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const spki = publicKey.export({ format: 'der', type: 'spki' });
    return { privateKey, pubkeyHex: spki.subarray(spki.length - 32).toString('hex') };
}
// One SIGNED v0 section (state_root threaded in so it can bind a balance proof),
// returned as the checkpoint object, the section's wire fragment, the explorer
// section row and the qualifying validator set. `network` is a parameter so the
// header-network rule can be exercised: the signature covers the canonical built
// with THIS network, and the wire fragment never carries it.
function makeSignedSection(opts) {
    opts = opts || {};
    const chain = opts.chain || CHAIN;
    const net   = opts.network || NET;
    const signer = makeSigner();
    const cp = {
        chain, network: net, block_index: 100, block_hash: 'c0'.repeat(32),
        ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
        checkpoint_seq: (opts.seq != null ? opts.seq : 7), snapshot_block: 100,
        state_root: opts.stateRoot || ('d4'.repeat(32)), state_root_version: 1,
        block_merkle_root: 'e5'.repeat(32), block_merkle_version: 1, validator_signatures: []
    };
    const canonical = checkpoint.canonicalCheckpoint(cp);
    const sigs = [{ pubkey: signer.pubkeyHex, sig: crypto.sign(null, Buffer.from(canonical, 'utf8'), signer.privateKey).toString('hex') }];
    cp.validator_signatures = sigs;
    const validators = [{ pubkey: signer.pubkeyHex, source: signer.pubkeyHex, weight: '100' }];
    // A section omits NETWORK (§2.1): it is carried once, in the bundle header.
    const fields = [cp.chain, cp.block_index, cp.block_hash, cp.ledger_hash, cp.actions_hash,
        cp.contract_hash, cp.checkpoint_seq, cp.snapshot_block, cp.state_root, cp.state_root_version,
        cp.block_merkle_root, cp.block_merkle_version, sigs.length, sigs[0].pubkey, sigs[0].sig];
    // The explorer serves one row PER SECTION, each carrying the header network.
    const record = {
        version: 0, chain: cp.chain, network: cp.network, block_index: cp.block_index, block_hash: cp.block_hash,
        ledger_hash: cp.ledger_hash, actions_hash: cp.actions_hash, contract_hash: cp.contract_hash,
        checkpoint_seq: cp.checkpoint_seq, snapshot_block: cp.snapshot_block,
        state_root: cp.state_root, state_root_version: cp.state_root_version,
        block_merkle_root: cp.block_merkle_root, block_merkle_version: cp.block_merkle_version,
        validator_signatures: JSON.stringify(sigs),
        block_index_doge: (opts.dogeBlock != null ? opts.dogeBlock : 1000), tx_hash: 'dd'.repeat(32)
    };
    return { cp, sigs, validators, fields, record };
}

// A whole v0 bundle: header, sections CHAIN-ascending, publisher tail.
function makeSignedBundle(sections, headerNetwork) {
    const ordered = sections.slice().sort((a, b) => (a.cp.chain < b.cp.chain ? -1 : a.cp.chain > b.cp.chain ? 1 : 0));
    const publisher = 'ab'.repeat(32);
    const parts = ['0', headerNetwork || NET, 100, ordered.length];
    for (const s of ordered) parts.push(...s.fields);
    parts.push(publisher, 0);
    return { wire: parts.join('|'), publisher, ordered };
}

describe('SPV Phase 4: DOGE-anchor cold-start trust', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('parseAnchorV0 splits the FROZEN vector into its three sections', function () {
        if (!fs.existsSync(VECTOR_FILE)) { missingSibling('the frozen ANCHOR vector at ' + VECTOR_FILE); return this.skip(); }
        const vec = JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf8'));
        const b = light.parseAnchorV0(vec.vectors.v0);
        assert.strictEqual(b.version, 0);
        assert.strictEqual(b.network, vec.fixture.bundle.network);
        assert.strictEqual(b.snapshot_block, vec.fixture.bundle.snapshot_block);
        assert.strictEqual(b.section_count, 3);
        assert.strictEqual(b.sections.length, 3);
        // The wire is CHAIN-ascending (D5); the fixture deliberately lists the sections
        // out of order, so echoing fixture order would fail here.
        assert.deepStrictEqual(b.sections.map(s => s.chain), ['BTC', 'DOGE', 'LTC']);
        const byChain = Object.fromEntries(vec.fixture.bundle.sections.map(s => [s.chain, s]));
        for (const s of b.sections) {
            const f = byChain[s.chain];
            assert.strictEqual(s.block_index, f.block_index, s.chain + ' block_index');
            assert.strictEqual(s.checkpoint_seq, f.checkpoint_seq, s.chain + ' checkpoint_seq');
            assert.strictEqual(s.snapshot_block, f.snapshot_block, s.chain + ' snapshot_block');
            assert.strictEqual(s.state_root, f.state_root, s.chain + ' state_root');
            assert.strictEqual(s.state_root_version, f.state_root_version);
            assert.strictEqual(s.block_merkle_root, f.block_merkle_root, s.chain + ' block_merkle_root');
            assert.strictEqual(s.block_merkle_version, f.block_merkle_version);
            assert.strictEqual(s.validator_signatures.length, f.validator_signatures.length);
            // Pairs are PUBKEY-ascending on the wire; the fixture's BTC section lists
            // them descending on purpose, so this fails if the parser trusts order.
            const asc = s.validator_signatures.map(x => x.pubkey);
            assert.deepStrictEqual(asc, asc.slice().sort(), s.chain + ' sig pairs must be pubkey-ascending');
        }
        assert.strictEqual(b.publisher, vec.fixture.bundle.publisher);
        assert.strictEqual(b.publisher_attestations.length, vec.fixture.bundle.attest_sigs.length);
    });

    it('every v0 section takes NETWORK from the HEADER, never from the section', function () {
        if (!fs.existsSync(VECTOR_FILE)) { missingSibling('the frozen ANCHOR vector at ' + VECTOR_FILE); return this.skip(); }
        const vec = JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf8'));
        const b = light.parseAnchorV0(vec.vectors.v0);
        for (const s of b.sections)
            assert.strictEqual(s.network, vec.fixture.bundle.network, s.chain + ' must carry the header network');
        // The rule is load-bearing, not cosmetic: the per-chain canonical the validators
        // signed embeds the network, so a section normalized with any other value (or a
        // blank) verifies a DIFFERENT string than the one that was signed.
        const s = makeSignedSection({ chain: 'LTC' });
        const { wire } = makeSignedBundle([s], NET);
        const sec = light.anchorBundleSection(light.parseAnchorV0(wire), 'LTC');
        assert.strictEqual(checkpoint.verifyCheckpoint(sec, s.validators).valid, true);
        const wrong = light.anchorBundleSection(light.parseAnchorV0(wire.replace('0|' + NET + '|', '0|testnet|')), 'LTC');
        assert.strictEqual(wrong.network, 'testnet');
        assert.strictEqual(checkpoint.verifyCheckpoint(wrong, s.validators).valid, false,
            'a section canonicalized with the wrong network must not verify');
    });
});

describe('SPV Phase 4: DOGE-anchor cold-start trust', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('fetchAnchoredCheckpoint retrieves the LTC section off the FROZEN v0 vector (AT3, offline)', async function () {
        if (!fs.existsSync(VECTOR_FILE)) { missingSibling('the frozen ANCHOR vector at ' + VECTOR_FILE); return this.skip(); }
        const vec = JSON.parse(fs.readFileSync(VECTOR_FILE, 'utf8'));
        const b = light.parseAnchorV0(vec.vectors.v0);
        // Explorer serves one row PER SECTION under v0 (§2.4); reproduce that shape from
        // the parsed bundle so the fetch path is exercised end to end, not just the parser.
        const rows = b.sections.map(s => Object.assign({ version: b.version, tx_hash: 'fixturetx', block_index_doge: 2000 }, s));
        let calledUrl = null;
        const fetchImpl = async (url) => {
            calledUrl = url;
            return { ok: true, status: 200, json: async () => rows };
        };
        const r = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'RDOGE',
            targetChain: 'LTC', targetCoin: 'RLTC', validators: [], dogeTipHeight: 2100, minDepth: 1, fetchImpl });
        assert.match(calledUrl, /\/RDOGE\/api\/anchors\/LTC\/chain$/, 'must query the TARGET chain, off the DOGE explorer');
        // The row returned is the LTC section specifically, not BTC/DOGE, and every
        // field survived parse -> explorer-row shape -> anchorToCheckpoint byte-identical
        // to the frozen fixture (this is the mechanism AT3 exercises on the live stack).
        const ltcFixture = vec.fixture.bundle.sections.find(s => s.chain === 'LTC');
        assert.strictEqual(r.anchor.chain, 'LTC');
        assert.strictEqual(r.checkpoint.block_index, ltcFixture.block_index);
        assert.strictEqual(r.checkpoint.checkpoint_seq, ltcFixture.checkpoint_seq);
        assert.strictEqual(r.checkpoint.state_root, ltcFixture.state_root);
        assert.strictEqual(r.checkpoint.block_merkle_root, ltcFixture.block_merkle_root);
        // The frozen vector's signatures are fixture placeholders, not real signatures
        // over a real validator set, so quorum fails; reaching CHECKPOINT_QUORUM_FAILED
        // (rather than NO_ROOT_ANCHOR / MALFORMED_ROOT / ROOTS_NOT_SIGNED) proves the
        // section cleared retrieval, filtering and root-shape checks first.
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'CHECKPOINT_QUORUM_FAILED');
    });

    it('anchorBundleSection picks a chain and returns null for a chain the bundle omits', function () {
        const btc = makeSignedSection({ chain: 'BTC' });
        const ltc = makeSignedSection({ chain: 'LTC' });
        const { wire } = makeSignedBundle([ltc, btc], NET);
        const b = light.parseAnchorV0('ANCHOR|' + wire);              // leading ANCHOR| tolerated
        assert.deepStrictEqual(b.sections.map(s => s.chain), ['BTC', 'LTC']);
        assert.strictEqual(light.anchorBundleSection(b, 'ltc').checkpoint_seq, 7);
        assert.strictEqual(light.anchorBundleSection(b, 'BTC').chain, 'BTC');
        // A chain that cut no new checkpoint is simply absent (D4), not an error.
        assert.strictEqual(light.anchorBundleSection(b, 'DOGE'), null);
        assert.strictEqual(light.anchorBundleSection(wire, 'LTC').chain, 'LTC');   // raw wire accepted
    });

    it('parseAnchorV0 REFUSES the retired v3/v4/v5 and superseded v7 anchor versions', function () {
        for (const v of ['3', '4', '5', '7'])
            assert.throws(() => light.parseAnchorV0(v + '|BTC|regtest|1'), /not an ANCHOR bundle/, 'v' + v + ' must be refused');
        assert.throws(() => light.parseAnchorV0('0|regtest|100|0'), /bad ANCHOR SECTION_COUNT/);
        assert.throws(() => light.parseAnchorV0('0|regtest|100|2|BTC|1|aa|bb|cc|dd|1|100|ee|1|ff|1|1|pk|sig'),
            /truncated ANCHOR section 1/);
    });
});

describe('SPV Phase 4: DOGE-anchor cold-start trust', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('a v0 LTC section verifies through verifyAnchoredCheckpoint (AT2, offline)', function () {
        const ltc = makeSignedSection({ chain: 'LTC' });
        const doge = makeSignedSection({ chain: 'DOGE' });
        const btc = makeSignedSection({ chain: 'BTC' });
        const { wire } = makeSignedBundle([ltc, doge, btc], NET);
        const sec = light.anchorBundleSection(wire, 'LTC');
        const r = light.verifyAnchoredCheckpoint({ checkpoint: sec, validators: ltc.validators, confirmations: 120, minDepth: 60 });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.checkpoint.chain, 'LTC');
        assert.strictEqual(r.checkpoint.network, NET);
        // Each section carries its OWN signer set: LTC's quorum must not admit BTC's.
        const cross = light.verifyAnchoredCheckpoint({ checkpoint: sec, validators: btc.validators, confirmations: 120, minDepth: 60 });
        assert.strictEqual(cross.verified, false);
        assert.strictEqual(cross.reason, 'CHECKPOINT_QUORUM_FAILED');
    });

    it('verifyAnchoredCheckpoint ACCEPTS a quorum-signed anchor buried past minDepth', function () {
        const { cp, validators } = makeSignedSection();
        const r = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 120, minDepth: 60 });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.confirmations, 120);
    });

    it('verifyAnchoredCheckpoint REJECTS an anchor too shallow on DOGE', function () {
        const { cp, validators } = makeSignedSection();
        const r = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 5, minDepth: 60 });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'INSUFFICIENT_DOGE_DEPTH');
    });

    it('verifyAnchoredCheckpoint REJECTS a rootless (non-v3) checkpoint', function () {
        const { cp, validators } = makeSignedSection();
        cp.state_root = null; cp.block_merkle_root = null;
        const r = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 120 });
        assert.strictEqual(r.reason, 'NOT_A_V3_ANCHOR');
    });
});

describe('SPV Phase 4: DOGE-anchor cold-start trust', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('verifyAnchoredCheckpoint REJECTS roots the signature never covered', function () {
        // A legitimately signed ROOTLESS checkpoint: with the version fields absent,
        // canonicalCheckpoint omits the root suffix, so the quorum signs the legacy
        // canonical. Republishing it as a buried v3 with attacker-chosen roots would
        // pass, because the old signature still verifies against that same canonical.
        const signer = makeSigner();
        const cp = {
            chain: CHAIN, network: NET, block_index: 100, block_hash: 'c0'.repeat(32),
            ledger_hash: 'a1'.repeat(32), actions_hash: 'b2'.repeat(32), contract_hash: 'c3'.repeat(32),
            checkpoint_seq: 7, snapshot_block: 100,
            state_root: null, state_root_version: null,
            block_merkle_root: null, block_merkle_version: null, validator_signatures: []
        };
        const canonical = checkpoint.canonicalCheckpoint(cp);
        cp.validator_signatures = [{ pubkey: signer.pubkeyHex, sig: crypto.sign(null, Buffer.from(canonical, 'utf8'), signer.privateKey).toString('hex') }];
        const validators = [{ pubkey: signer.pubkeyHex, source: signer.pubkeyHex, weight: '100' }];
        // The signature is genuine and the quorum is real, but the base
        // verifier ALSO refuses a rootless row once the commitment is active, so this
        // attack is blocked a layer earlier than the SPV checks below. Those checks
        // stay asserted: they are the backstop if the row ever reaches them.
        assert.strictEqual(checkpoint.verifyCheckpoint(cp, validators).valid, false);

        // Attack: graft roots on without the version fields, so the canonical (and
        // therefore the signature that covers it) is unchanged.
        cp.state_root = 'ff'.repeat(32);
        cp.block_merkle_root = 'ee'.repeat(32);
        const r = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 300, minDepth: 60 });
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'ROOTS_NOT_SIGNED');

        // Supplying the versions too pulls the roots into the canonical, which the
        // old signature no longer matches: the attack fails on quorum instead.
        cp.state_root_version = 1; cp.block_merkle_version = 1;
        const r2 = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 300, minDepth: 60 });
        assert.strictEqual(r2.verified, false);
        assert.strictEqual(r2.reason, 'CHECKPOINT_QUORUM_FAILED');
    });

    it('verifyAnchoredCheckpoint REJECTS roots on a snapshot below the CHECKPOINT_COMMITMENT flag day', function () {
        // The append condition is the registry row read through activeAt (W5): a
        // mainnet snapshot_block one below the armed height keeps the roots out of
        // the signed canonical, so a rooted row there carries roots nobody signed,
        // whatever its version fields say. The registry's own row is the oracle.
        const registry = require('../../../../src/consensus/gate_registry');
        const armed = registry.get('checkpoint_commitment_activation.CHECKPOINT_COMMITMENT_ACTIVATION').mainnet;
        assert.ok(Number.isInteger(armed) && armed > 0, 'mainnet is armed to a concrete height');
        const { cp, validators } = makeSignedSection({ network: 'mainnet' });
        cp.snapshot_block = armed - 1;
        const below = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 300, minDepth: 60 });
        assert.strictEqual(below.verified, false);
        assert.strictEqual(below.reason, 'ROOTS_NOT_SIGNED');
        // At the armed height the same row passes the flag-day gate and fails
        // further down (the fixture signature was over snapshot_block 100).
        cp.snapshot_block = armed;
        const at = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 300, minDepth: 60 });
        assert.notStrictEqual(at.reason, 'ROOTS_NOT_SIGNED');
    });

    it('verifyAnchoredCheckpoint REJECTS a root that is not a 32-byte hex value', function () {
        const { cp, validators } = makeSignedSection();
        cp.state_root = 'not-a-root';
        const r = light.verifyAnchoredCheckpoint({ checkpoint: cp, validators, confirmations: 300, minDepth: 60 });
        assert.strictEqual(r.reason, 'MALFORMED_ROOT');
    });
});

describe('SPV Phase 4: DOGE-anchor cold-start trust', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('fetchAnchoredCheckpoint picks the newest v0 section row and verifies depth + quorum', async function () {
        const a = makeSignedSection({ dogeBlock: 1000 });
        // an older, lower-seq anchor that should be ignored in favor of the newest
        const fetchImpl = async (url) => {
            if (url.includes('/api/anchors/'))
                return { ok: true, status: 200, json: async () => ({ data: [
                    Object.assign({}, a.record, { checkpoint_seq: 3, block_index_doge: 500 }),
                    a.record
                ] }) };
            return { ok: false, status: 404, json: async () => ({}) };
        };
        const r = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'DOGE',
            targetChain: CHAIN, validators: a.validators, dogeTipHeight: 1200, minDepth: 60, fetchImpl });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.checkpoint.checkpoint_seq, 7);     // newest, not the seq-3 decoy
        assert.strictEqual(r.confirmations, 201);               // 1200 - 1000 + 1
        assert.strictEqual(r.dogeTxid, 'dd'.repeat(32));
    });

    it('fetchAnchoredCheckpoint REFUSES retired v3/v5 rows as a trust root', async function () {
        // Pre-launch the retired one-anchor-per-chain wires are deleted, not deprecated
        // (D2), so a replayed v3/v5 row must not bootstrap a client even though it still
        // carries roots and a genuine signature.
        for (const version of [3, 5]) {
            const a = makeSignedSection({ dogeBlock: 1000 });
            a.record.version = version;
            const fetchImpl = async (url) => url.includes('/api/anchors/')
                ? { ok: true, status: 200, json: async () => ({ data: [a.record] }) }
                : { ok: false, status: 404, json: async () => ({}) };
            const r = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'DOGE',
                targetChain: CHAIN, validators: a.validators, dogeTipHeight: 1200, minDepth: 60, fetchImpl });
            assert.strictEqual(r.verified, false, 'v' + version + ' must not verify');
            assert.strictEqual(r.reason, 'NO_ROOT_ANCHOR');
            // Control: the identical row at version 0 is accepted, so the refusal is the
            // version gate and not some other property of the fixture.
            a.record.version = 0;
            const ok = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'DOGE',
                targetChain: CHAIN, validators: a.validators, dogeTipHeight: 1200, minDepth: 60, fetchImpl });
            assert.strictEqual(ok.verified, true, ok.reason);
        }
    });
});

describe('SPV Phase 4: DOGE-anchor cold-start trust', function () {

    beforeEach(function () {
        light.clearValidatorSetCache();
    });

    it('fetchAnchoredCheckpoint keeps its per-chain filter over v0 section rows', async function () {
        // A bundle reaches the explorer as one row per section sharing an action_index,
        // so the chain filter selects the section and needs no bundle awareness.
        const btc = makeSignedSection({ chain: 'BTC', dogeBlock: 1000 });
        const ltc = makeSignedSection({ chain: 'LTC', dogeBlock: 1000 });
        const fetchImpl = async (url) => url.includes('/api/anchors/')
            ? { ok: true, status: 200, json: async () => ({ data: [btc.record, ltc.record] }) }
            : { ok: false, status: 404, json: async () => ({}) };
        const r = await light.fetchAnchoredCheckpoint({ explorerUrl: 'https://x', dogeCoin: 'DOGE',
            targetChain: 'LTC', validators: ltc.validators, dogeTipHeight: 1200, minDepth: 60, fetchImpl });
        assert.strictEqual(r.verified, true, r.reason);
        assert.strictEqual(r.checkpoint.chain, 'LTC');
    });
});
