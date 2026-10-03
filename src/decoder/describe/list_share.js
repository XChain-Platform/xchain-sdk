'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { str } = require('./value_format.js');
const { decodeListCreateMeta } = require('./list_meta_create.js');

function decodeUnionListCreate(items, memo, chainSuffix) {
    const count = items.length;
    return {
        summary: `Create union list of ${count || '?'} member lists${chainSuffix}`,
        details: [
            { label: 'Type', value: 'Union' },
            { label: 'Items', value: String(count) },
            ...(count > 0 && count <= 5
                ? [{ label: 'Member list indexes', value: items.join(', ') }]
                : []),
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: count === 0 ? ['List has no items.'] : [],
    };
}

function decodeListShare(p) {
    const idx = str(p.LIST_ACTION_INDEX);
    const memo = str(p.MEMO);
    return {
        summary: `Share list #${idx || '?'} on every chain`,
        details: [{ label: 'List action index', value: idx }, ...(memo ? [{ label: 'Memo', value: memo }] : [])],
        warnings: [
            'Sharing is permanent. There is no unshare.',
            'Sharing charges the LIST_SHARE fee.',
            ...(!idx ? ['List action index is empty.'] : []),
        ],
    };
}

function decodeListTransfer(p) {
    const idx = str(p.LIST_ACTION_INDEX);
    const dest = str(p.DESTINATION).replace(/^\^(\d+)$/, 'address id $1');
    const memo = str(p.MEMO);
    return {
        summary: `Transfer list #${idx || '?'} to ${dest || '?'}`,
        details: [
            { label: 'List action index', value: idx },
            { label: 'Destination', value: dest },
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            'This transfer cannot be undone.',
            'The new owner alone can edit, share or transfer the list.',
            ...(!idx ? ['List action index is empty.'] : []),
            ...(!dest ? ['Destination is empty.'] : []),
        ],
    };
}

function describeMetaField(value) {
    if (!value) return 'Unchanged';
    if (value === '-') return 'Cleared';
    return `Set to: ${value}`;
}

function decodeListSetMeta(p) {
    const idx = str(p.LIST_ACTION_INDEX);
    const name = str(p.NAME);
    const description = str(p.DESCRIPTION);
    const memo = str(p.MEMO);
    return {
        summary: `Update metadata on list #${idx || '?'}`,
        details: [
            { label: 'List action index', value: idx },
            { label: 'Name', value: describeMetaField(name) },
            { label: 'Description', value: describeMetaField(description) },
            ...(memo ? [{ label: 'Memo', value: memo }] : []),
        ],
        warnings: [
            'Updating a shared list name or description charges the shared-list edit fee.',
            ...(!name && !description
                ? ['Name and description are both unchanged. The indexer will refuse this action as NAME (no change).']
                : []),
            ...(!idx ? ['List action index is empty.'] : []),
        ],
    };
}

function decodeListMetadata(p, chainSuffix) {
    const version = str(p.VERSION);
    if (version === '4') return decodeListCreateMeta(p, chainSuffix);
    if (version === '5') return decodeListSetMeta(p);
    return null;
}

module.exports = { decodeUnionListCreate, decodeListShare, decodeListTransfer, decodeListSetMeta, decodeListMetadata };
