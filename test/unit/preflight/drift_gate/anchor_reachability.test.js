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
const { anchorReachability } = require('../../../../bin/check-preflight-drift.js');

describe('preflight drift anchor reachability', function () {
    it('distinguishes reachable, shallow and unreachable anchors', function () {
        const success = () => undefined;
        assert.strictEqual(anchorReachability('/indexer', 'anchor', success), 'reachable');

        const shallowCalls = [];
        const shallow = (file, args) => {
            shallowCalls.push([file, args]);
            if (args.includes('merge-base')) throw new Error('anchor absent');
            return 'true\n';
        };
        assert.strictEqual(anchorReachability('/indexer', 'anchor', shallow), 'shallow');
        assert.deepStrictEqual(shallowCalls[1][1].slice(-2), ['rev-parse', '--is-shallow-repository']);

        const unreachable = () => { throw new Error('not reachable'); };
        assert.strictEqual(anchorReachability('/indexer', 'anchor', unreachable), 'unreachable');
    });
});
