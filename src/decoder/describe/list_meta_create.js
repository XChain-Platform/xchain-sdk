'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { str, toArray } = require('./value_format.js');

function decodeListCreateMeta(p, chainSuffix = '') {
    const type = str(p.TYPE);
    const name = str(p.NAME);
    const description = str(p.DESCRIPTION);
    const memo = str(p.MEMO);
    const items = toArray(p.ITEM);
    const count = items.length;
    const union = type === '3';
    const kind = type === '1' ? 'token' : type === '2' ? 'address' : union ? 'union' : 'item';
    const countText = union
        ? `${count || '?'} member lists`
        : `${count || '?'} item${count === 1 ? '' : 's'}`;

    return {
        summary: `Create ${kind} list${name ? ` "${name}"` : ''} of ${countText}${chainSuffix}`,
        details: [
            { label: 'Type', value: type === '1' ? 'Token' : type === '2' ? 'Address' : union ? 'Union' : type },
            ...(name ? [{ label: 'Name', value: name }] : []),
            ...(description ? [{ label: 'Description', value: description }] : []),
            { label: 'Items', value: String(count) },
            ...(count > 0
                ? [{ label: union ? 'Member list indexes' : 'Sample', value: items.slice(0, 5).join(', ') }]
                : []),
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            ...(!type ? ['List type is empty. Specify a token list or an address list.'] : []),
            ...(count === 0 ? ['List has no items.'] : []),
            ...(name === '-' ? ['Name cannot be cleared when creating a list. The indexer will refuse it as NAME (format).'] : []),
            ...(description === '-' ? ['Description cannot be cleared when creating a list. The indexer will refuse it as DESCRIPTION (format).'] : []),
        ],
    };
}

module.exports = { decodeListCreateMeta };
