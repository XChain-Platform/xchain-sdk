// Copyright © 2025-2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

'use strict';

const { create, all } = require('mathjs');

const math = create(all, { number: 'BigNumber', precision: 64 });
const PLAIN_DECIMAL = /^\d+(?:\.\d+)?$/;

function holdingFromBalances(rows, tick, min) {
    if (!Array.isArray(rows))
        throw new TypeError('rows must be an array');
    if (typeof tick !== 'string' || tick.length === 0)
        throw new TypeError('tick must be a non-empty string');

    let minimum;
    if (typeof min === 'string' && PLAIN_DECIMAL.test(min)) {
        minimum = math.bignumber(min);
    } else if (typeof min === 'number' && Number.isFinite(min) && min >= 0) {
        minimum = math.bignumber(min);
    } else {
        throw new TypeError('min must be a non-negative decimal string or finite number');
    }

    let amount = math.bignumber(0);
    for (const row of rows) {
        if (!row || row.tick !== tick) continue;
        if (typeof row.amount !== 'string' || !PLAIN_DECIMAL.test(row.amount))
            throw new TypeError(`invalid amount for tick ${tick}`);
        amount = amount.plus(math.bignumber(row.amount));
    }

    return { holds: amount.gte(minimum), amount };
}

module.exports = { holdingFromBalances };
