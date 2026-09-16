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
const sinon = require('sinon');
const Workflows = require('../../../../src/actions/workflows.js');
const NftHelpers = require('../../../../src/actions/nft.js');

const FAKE_WIF = 'L1rkA9mYRjVPVdvMuVbHRMX6SPHM7fNwCEfT3AV2qCGAmJ8wNfp';

// Tests

function makeAttachSdk(calls) {
    let fileCount = 0;
    const session = {
        file: async (params, enc) => {
            fileCount += 1;
            calls.files.push({ params, enc });
            return { txid: 'file_tx' + fileCount, indexed: { action_index: 100 + fileCount } };
        },
        link: async (params) => {
            calls.links.push(params);
            return { txid: 'link_tx', indexed: { action_index: 200 } };
        },
        issue: async (params) => {
            calls.issues.push(params);
            return { txid: 'describe_tx', indexed: { action_index: 300 } };
        },
    };
    const sdk = { session: () => session };
    sdk.nft = new NftHelpers(sdk);
    return sdk;
}

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    // attachContent() (optional on-chain TIS authoring legs)
    describe('attachContent()', function () {
        it('without tis: uploads + links only', async function () {
            const calls = { files: [], links: [], issues: [] };
            const wf = new Workflows(makeAttachSdk(calls));
            const out = await wf.attachContent(FAKE_WIF, {
                coin: 'BTC', issueActionIndex: 7,
                file: { name: 'a.png', type: 'image/png', rawData: 'x' },
            });
            assert.strictEqual(calls.files.length, 1);
            assert.strictEqual(calls.links.length, 1);
            assert.strictEqual(calls.issues.length, 0);
            assert.strictEqual(out.tisFile, undefined);
            assert.strictEqual(out.describe, undefined);
        });
    });
});

describe('Workflows', function () {

    afterEach(() => sinon.restore());

    describe('attachContent()', function () {
        it('with tis: authors the on-chain doc and points DESCRIPTION at it', async function () {
            const calls = { files: [], links: [], issues: [] };
            const wf = new Workflows(makeAttachSdk(calls));
            const out = await wf.attachContent(FAKE_WIF, {
                coin: 'BTC', issueActionIndex: 7,
                file: { name: 'a.png', type: 'image/png', rawData: 'x' },
                tis: { tick: 'art1', name: 'Art One' },
            });
            // Second FILE upload is the TIS JSON document...
            assert.strictEqual(calls.files.length, 2);
            const tisUpload = calls.files[1];
            assert.strictEqual(tisUpload.params.name, 'ART1.json');
            assert.strictEqual(tisUpload.params.type, 'application/json');
            const doc = JSON.parse(Buffer.from(tisUpload.enc.rawData, 'binary').toString('utf8'));
            //...whose images[] data_ref points at the artwork upload (action 101)
            assert.strictEqual(doc.images[0].data_ref, 'action:101');
            assert.strictEqual(doc.tick, 'ART1');
            //...and ISSUE v1 points the token's DESCRIPTION at the doc (action 102)
            assert.strictEqual(calls.issues.length, 1);
            assert.deepStrictEqual(calls.issues[0], {
                version: '1', tick: 'art1', description: 'action:102',
            });
            assert.strictEqual(out.tisFile.txid, 'file_tx2');
            assert.strictEqual(out.describe.txid, 'describe_tx');
        });
    });
});
