//  doctrine test-coverage program: unit coverage for src/addressRefFields.js.
// This is the canonical map of which ACTION params carry an ADDRESS value (a
// consensus surface: it decides which values become ^id references). The SDK
// only compacts the unconditional single-value fields (SDK_COMPACTABLE, a
// strict subset), and must never emit a ^id the indexer would not assign. Pins
// that derivation and the exclusion of multi-value / type-gated fields.

const assert = require('assert');
const { ADDRESS_REF_FIELDS, SDK_COMPACTABLE } = require('../../src/addressRefFields.js');

describe('addressRefFields', function () {
    it('maps the core address-bearing actions', function () {
        for (const action of ['SEND', 'MINT', 'ISSUE', 'DISPENSER', 'DEPLOY', 'LIST']) {
            assert.ok(Array.isArray(ADDRESS_REF_FIELDS[action]), `${action} must be mapped`);
            assert.ok(ADDRESS_REF_FIELDS[action].length > 0);
        }
    });

    it('SDK_COMPACTABLE is a sorted, duplicate-free list', function () {
        const sorted = [...SDK_COMPACTABLE].sort();
        assert.deepStrictEqual(SDK_COMPACTABLE, sorted);
        assert.strictEqual(new Set(SDK_COMPACTABLE).size, SDK_COMPACTABLE.length);
    });

    it('excludes multi-value and type-gated (LIST.ITEM) fields from compaction', function () {
        // LIST.ITEM is type-gated (listType) and must never be compacted.
        assert.ok(!SDK_COMPACTABLE.includes('ITEM'), 'LIST.ITEM must not be compactable');
    });

    it('includes a field that is single-value in at least one action (DESTINATION)', function () {
        // DESTINATION is multi in SEND but single in MINT/MESSAGE/SWEEP, so it is
        // compactable via those actions.
        assert.ok(SDK_COMPACTABLE.includes('DESTINATION'));
    });

    it('SDK_COMPACTABLE is a subset of the fields declared in the map', function () {
        const declared = new Set();
        for (const specs of Object.values(ADDRESS_REF_FIELDS))
            for (const s of specs) declared.add(s.field);
        for (const f of SDK_COMPACTABLE)
            assert.ok(declared.has(f), `${f} must be a declared address field`);
    });
});
