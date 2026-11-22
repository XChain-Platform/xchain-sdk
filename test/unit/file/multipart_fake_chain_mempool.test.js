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
const { createFakeMultipartChain } = require('../../helpers/multipart_fake_chain.js');

function addPieces(chain, count, offset = 0, state = 'mempool') {
    for (let index = 0; index < count; index++) {
        chain.addPiece({
            kind: 'part', source: 'alice', fileHash: 'file', partIndex: index,
            rawData: Buffer.from([index]), txid: 'piece-' + (offset + index), state,
        });
    }
}

describe('multipart fake chain mempool metrics', function () {
    it('tracks the current count and all-time high-water mark', function () {
        const chain = createFakeMultipartChain();

        addPieces(chain, 5);
        expect(chain.mempoolCount()).to.equal(5);
        expect(chain.mempoolHighWater()).to.equal(5);

        chain.mine();
        expect(chain.mempoolCount()).to.equal(0);
        expect(chain.mempoolHighWater()).to.equal(5);

        addPieces(chain, 3, 5);
        expect(chain.mempoolCount()).to.equal(3);
        expect(chain.mempoolHighWater()).to.equal(5);

        chain.drop('piece-5');
        expect(chain.mempoolCount()).to.equal(2);
        expect(chain.mempoolHighWater()).to.equal(5);

        addPieces(chain, 1, 8, 'confirmed');
        expect(chain.mempoolCount()).to.equal(2);
        expect(chain.mempoolHighWater()).to.equal(5);
    });
});
