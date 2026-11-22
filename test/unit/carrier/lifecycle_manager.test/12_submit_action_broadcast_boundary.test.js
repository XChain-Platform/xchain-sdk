// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

'use strict';

const assert = require('assert');
const LifecycleManager = require('../../../../src/carrier/lifecycle_manager.js');
const { FAKE_WIF, buildSignedTx, makeSdk } = require('./helpers/lifecycle_manager.js');

describe('LifecycleManager submit broadcast boundary', () => {
    it('marks a create failure as proven pre-broadcast', async () => {
        const sdk = makeSdk({}, { createTx: async () => {
            throw Object.assign(new Error('create failed'), { details: {} });
        } });
        const manager = new LifecycleManager(sdk);
        await assert.rejects(
            manager.submitAction({ action: 'SEND', params: {} }, {}, { wif: FAKE_WIF }),
            (error) => error.preBroadcast === true && error.details.preBroadcast === true);
    });

    it('keeps a broadcast RPC failure ambiguous and attaches the signed txid', async () => {
        const signed = buildSignedTx();
        const sdk = makeSdk({
            wallet: { signPsbt: () => ({ txHex: signed.txHex, txid: signed.txid, psbtHex: signed.psbtHex }) },
        }, {
            broadcastTx: async () => { throw new Error('ack lost'); },
        });
        const manager = new LifecycleManager(sdk);
        await assert.rejects(
            manager.submitAction({ action: 'SEND', params: {} }, {}, { wif: FAKE_WIF }),
            (error) => error.preBroadcast !== true
                && error.details.txid === signed.txid
                && error.details.broadcast === 'unknown');
    });

    it('marks a broadcasting progress callback failure before invoking broadcast', async () => {
        let broadcasted = false;
        const sdk = makeSdk({}, { broadcastTx: async () => { broadcasted = true; } });
        const manager = new LifecycleManager(sdk);
        await assert.rejects(manager.submitAction(
            { action: 'SEND', params: {} }, {},
            { wif: FAKE_WIF, onProgress: (step) => {
                if (step === 'broadcasting') throw new Error('progress failed');
            } }), (error) => error.preBroadcast === true);
        assert.strictEqual(broadcasted, false);
    });
});
