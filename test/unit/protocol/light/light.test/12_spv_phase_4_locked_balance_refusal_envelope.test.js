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
 * verifyLockedBalance against the explorer's real proof-route error envelope,
 * { error: <prose>, code: <stable code> } on a non-2xx status. These cases need
 * no proof: every one is answered before verification starts.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');
const light  = require('../../../../../src/protocol/light_client.js');

const COIN = 'RBTC', TICK = 'XCHAIN';
const ADDR_A = '1AddrAaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// The explorer's verbatim prose for the below-arming refusal (state_proofs.js locked-balance map).
const LEAF_PROSE = 'The locked-balance leaf is not committed at this height (balances_root does not cover the XCHAIN_ESC domain here, so absence cannot be proven)';

// verifyLockedBalance over the explorer's real error envelope: a 409 with a stable
// code is an answer (verified:false), every other non-2xx throws with status and code.
describe('SPV Phase 4: verifyLockedBalance proof-route error envelope', function () {
    const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status,
        json: async () => body });
    const ask = (fetchImpl) => light.verifyLockedBalance({ explorerUrl: 'https://x', coin: COIN,
        address: ADDR_A, tick: TICK, fetchImpl });
    const rejectsWith = async (fetchImpl, status, code) => {
        await assert.rejects(ask(fetchImpl), (err) => {
            assert.ok(err.message.startsWith('LightClient: explorer returned HTTP ' + status), err.message);
            assert.strictEqual(err.status, status);
            assert.strictEqual(err.code, code);
            return true;
        });
    };

    it('verifyLockedBalance returns a 409 CHECKPOINT_PRE_COMMITMENT refusal as verified:false', async function () {
        const r = await ask(reply(409, { error: 'Checkpoint predates the state-commitment flag-day', code: 'CHECKPOINT_PRE_COMMITMENT' }));
        assert.strictEqual(r.verified, false);
        assert.strictEqual(r.reason, 'CHECKPOINT_PRE_COMMITMENT');
        assert.strictEqual(r.amount, null);
    });

    it('verifyLockedBalance reads the stable code, not the prose, from a 2xx refusal body', async function () {
        const r = await ask(reply(200, { error: LEAF_PROSE, code: 'ESCROW_LEAF_NOT_COMMITTED' }));
        assert.strictEqual(r.reason, 'ESCROW_LEAF_NOT_COMMITTED');
        const legacy = await ask(reply(200, { error: 'ESCROW_LEAF_NOT_COMMITTED' }));
        assert.strictEqual(legacy.reason, 'ESCROW_LEAF_NOT_COMMITTED', 'the legacy internal shape keeps working');
    });

    it('verifyLockedBalance throws on 404 NO_CHECKPOINT with status and code attached', async function () {
        await rejectsWith(reply(404, { error: 'No signed checkpoint at or above this height', code: 'NO_CHECKPOINT' }), 404, 'NO_CHECKPOINT');
    });

    it('verifyLockedBalance throws on 501 NO_STATE_TREE and on a 503 mirror block', async function () {
        await rejectsWith(reply(501, { error: 'no state tree', code: 'NO_STATE_TREE' }), 501, 'NO_STATE_TREE');
        await rejectsWith(reply(503, { error: 'mirror is stale' }), 503, undefined);
    });

    it('verifyLockedBalance throws on a 409 whose body is unreadable or carries no code', async function () {
        const unreadable = async () => ({ ok: false, status: 409, json: async () => { throw new SyntaxError('bad json'); } });
        await rejectsWith(unreadable, 409, undefined);
        await rejectsWith(reply(409, { error: LEAF_PROSE }), 409, undefined);
    });
});
