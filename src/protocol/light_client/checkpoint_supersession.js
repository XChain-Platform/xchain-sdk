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
 * XChain SDK - Checkpoint supersession field normalization and refusal
 *
 ********************************************************************/

'use strict';

const CHECKPOINT_SUPERSEDED = 'CHECKPOINT_SUPERSEDED';

function nullableNumber(value) {
    return value == null ? null : Number(value);
}

function supersessionFields(row) {
    const source = row || {};
    return {
        supersedes_from: nullableNumber(source.supersedes_from),
        rules_digest: source.rules_digest == null ? null : String(source.rules_digest).toLowerCase(),
        superseded_by_seq: nullableNumber(source.superseded_by_seq)
    };
}

function refuseSuperseded(row, opts = {}) {
    const supersededBySeq = supersessionFields(row).superseded_by_seq;
    if (supersededBySeq == null || opts.allowSuperseded === true) return null;
    return {
        verified: false,
        reason: CHECKPOINT_SUPERSEDED,
        superseded_by_seq: supersededBySeq
    };
}

module.exports = { CHECKPOINT_SUPERSEDED, supersessionFields, refuseSuperseded };
