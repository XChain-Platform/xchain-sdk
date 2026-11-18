// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// The caller's maxFeeSats is a per-transaction ceiling, so the wave funding
// transaction is reconciled against it as well as every piece transaction.

const assert = require('assert');
const { fundPieces } = require('../../../src/actions/workflows/file_multipart_wave_funding.js');

function harness(reconcile) {
    const events = [];
    const sdk = {
        requireExplorer: () => ({ coin: 'RBTC' }),
        requireEncoder: () => ({ createTx: async () => ({ psbt: 'funding' }),
            broadcastTx: async () => { events.push('broadcast'); return {}; }, getTxBlock: async () => ({ height: 7 }) }),
        wallet: { getBitcoinNetwork: () => ({ dustThreshold: 5 }),
            decomposePsbt: () => ({ outputs: [{ address: 'source', value: 40, scriptPubKeyHex: '01' }] }),
            signPsbt: () => { events.push('sign'); return { txHex: 'f0', txid: 'f-txid' }; } },
    };
    const modules = {
        multipartFundingOutputs: (values, address) => ({ customOutputs: values.map(value => ({ address, value })) }),
        reconcileEncoded: (psbt, intent) => reconcile(intent),
        matchFundingOutputs: expected => expected.map((output, vout) => ({ vout, value: output.value })),
    };
    const source = { sourceAddress: 'source', pubkey: 'pub', lane: 'standard' };
    const wave = { pieces: [{ fundingIndex: 0 }], index: 0, total: 1 };
    const progress = { emit() {} };
    const run = opts => fundPieces(sdk, wave, null, source, 2,
        { quote: { rate: 2, pieceFundingValues: [40] }, ...opts }, modules, progress);
    return { run, events };
}

describe('multipart wave funding fee ceiling', function () {
    it('reconciles the funding transaction against the caller maxFeeSats', async function () {
        const seen = [];
        await harness(intent => seen.push(intent)).run({ maxFeeSats: 123 });
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0].label, 'multipart funding');
        assert.strictEqual(seen[0].maxFeeSats, 123);
    });

    it('lets maxFundingFeeSats raise the ceiling for the funding transaction alone', async function () {
        const seen = [];
        await harness(intent => seen.push(intent)).run({ maxFeeSats: 123, maxFundingFeeSats: 900 });
        assert.strictEqual(seen[0].maxFeeSats, 900);
    });

    it('refuses an over-cap funding transaction before it is signed or broadcast', async function () {
        const deny = intent => {
            if (intent.maxFeeSats != null && 500 > Number(intent.maxFeeSats)) throw new Error('FEE_OVER_CAP');
        };
        const { run, events } = harness(deny);
        await assert.rejects(() => run({ maxFeeSats: 123 }), /FEE_OVER_CAP/);
        assert.deepStrictEqual(events, []);
        await run({});
        assert.deepStrictEqual(events, ['sign', 'broadcast']);
    });
});
