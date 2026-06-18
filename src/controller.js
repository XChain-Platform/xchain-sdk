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
 **********************************************************************
 *
 * XChain Platform SDK - Controller Helpers
 *
 * The programmable-policy layer (controller-bound tokens + accounts) is a
 * composition of existing primitives, not a new action: a token routes a
 * native action class to a guard contract via ISSUE v6, and an account does
 * the same via ADDRESS v1 (see
 * xchain-documentation/protocol/Controller_Bound_Tokens.md). These helpers
 * build the bind/unbind params in one place (UNBIND=0 to bind, UNBIND=1 to
 * drop) so every client authors the same wire fields. All pure: no network,
 * no consensus. The indexer owns the live "already bound / not bound",
 * contract-existence and cooldown checks; these only build the params.
 *
 *   bind   → ISSUE v6:   VERSION|TICK|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO
 *   bind   → ADDRESS v1:        VERSION|CONTROLLER|ACTION_CLASS|COOLDOWN_BLOCKS|UNBIND|MEMO
 *
 ********************************************************************/

// The native action classes a token/account may gate. Must match the indexer's
// CONTROLLER_ACTION_CLASSES (xchain-indexer/src/config.js) and the SDK config
// ACTION_CLASSES (the validator's source) byte-for-byte.
const ACTION_CLASSES = ['transfer', 'trade', 'burn', 'mint', 'stake'];

class ControllerHelpers {

    // The canonical action-class list (for dropdowns / validation in clients).
    actionClasses() {
        return ACTION_CLASSES.slice();
    }

    // Bind a TOKEN's action class to a guard contract (ISSUE v6, UNBIND=0).
    //
    // tick          - the token TICK to gate (required)
    // controller    - ACTION_INDEX of the deployed guard contract (required)
    // actionClass   - which class to gate: transfer|trade|burn|mint|stake (required)
    // cooldownBlocks - (optional) drop-cooldown committed at bind (≥ 0)
    // memo          - (optional)
    //
    // Returns ISSUE params (camelCase; the SDK normalizes to UPPER_SNAKE and
    // auto-selects format v6).
    bindToken({ tick, controller, actionClass, cooldownBlocks, memo } = {}) {
        if (!tick) throw new Error('controller.bindToken: tick is required');
        if (controller === undefined || controller === null || String(controller) === '')
            throw new Error('controller.bindToken: controller is required');
        this._assertActionClass(actionClass, 'controller.bindToken');
        return this._tokenParams({ tick, controller, actionClass, cooldownBlocks, unbind: '0', memo });
    }

    // Unbind a TOKEN's action class from its guard contract (ISSUE v6, UNBIND=1).
    // The CONTROLLER field is omitted; the indexer ignores it on an unbind.
    //
    // tick        - the token TICK (required)
    // actionClass - which class to unbind (required)
    // memo        - (optional)
    unbindToken({ tick, actionClass, memo } = {}) {
        if (!tick) throw new Error('controller.unbindToken: tick is required');
        this._assertActionClass(actionClass, 'controller.unbindToken');
        return this._tokenParams({ tick, actionClass, unbind: '1', memo });
    }

    // Bind MY ACCOUNT's action class to a guard contract (ADDRESS v1, UNBIND=0).
    // The action is self-signed: the subject is the SOURCE address, so there is
    // no address param.
    //
    // controller    - ACTION_INDEX of the deployed guard contract (required)
    // actionClass   - which class to gate (required)
    // cooldownBlocks - (optional) drop-cooldown committed at bind (≥ 0)
    // memo          - (optional)
    bindAddress({ controller, actionClass, cooldownBlocks, memo } = {}) {
        if (controller === undefined || controller === null || String(controller) === '')
            throw new Error('controller.bindAddress: controller is required');
        this._assertActionClass(actionClass, 'controller.bindAddress');
        return this._addressParams({ controller, actionClass, cooldownBlocks, unbind: '0', memo });
    }

    // Unbind MY ACCOUNT's action class from its guard contract (ADDRESS v1, UNBIND=1).
    //
    // actionClass - which class to unbind (required)
    // memo        - (optional)
    unbindAddress({ actionClass, memo } = {}) {
        this._assertActionClass(actionClass, 'controller.unbindAddress');
        return this._addressParams({ actionClass, unbind: '1', memo });
    }

    // Shared ISSUE v6 skeleton. Drops undefined optionals so the SDK's
    // trailing-field stripping keeps the serialization compact.
    _tokenParams({ tick, controller, actionClass, cooldownBlocks, unbind, memo }) {
        let params = { tick, actionClass: String(actionClass).toLowerCase(), unbind: String(unbind) };
        if (controller     !== undefined && controller     !== null) params.controller     = String(controller);
        if (cooldownBlocks !== undefined && cooldownBlocks !== null) params.cooldownBlocks = String(cooldownBlocks);
        if (memo           !== undefined && memo           !== null) params.memo           = memo;
        return params;
    }

    // Shared ADDRESS v1 skeleton.
    _addressParams({ controller, actionClass, cooldownBlocks, unbind, memo }) {
        let params = { actionClass: String(actionClass).toLowerCase(), unbind: String(unbind) };
        if (controller     !== undefined && controller     !== null) params.controller     = String(controller);
        if (cooldownBlocks !== undefined && cooldownBlocks !== null) params.cooldownBlocks = String(cooldownBlocks);
        if (memo           !== undefined && memo           !== null) params.memo           = memo;
        return params;
    }

    _assertActionClass(actionClass, context) {
        if (!actionClass) throw new Error(context + ': actionClass is required');
        if (ACTION_CLASSES.indexOf(String(actionClass).toLowerCase()) === -1)
            throw new Error(context + ': actionClass must be one of: ' + ACTION_CLASSES.join(', '));
    }
}

module.exports = ControllerHelpers;
