// Unit coverage for src/addressRefFields.js, the canonical map of which
// ACTION params carry an ADDRESS value (a consensus surface: it decides which
// values become ^id references). The SDK only compacts the unconditional
// single-value fields (SDK_COMPACTABLE, a strict subset), and must never emit
// a ^id the indexer would not assign. Pins that derivation and the exclusion
// of multi-value / type-gated fields.

const assert = require('assert');
const { ADDRESS_REF_FIELDS, SDK_COMPACTABLE, SDK_COMPACTABLE_BY_ACTION } = require('../../src/addressRefFields.js');

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

    // The flat SDK_COMPACTABLE assertion above is fine on its own, but
    // nothing checked what each ACTION ends up allowed to compact, and that gap
    // shipped a real defect: SEND declares DESTINATION multi:true, yet the
    // per-action set was derived from the flat NAME set, so MINT/MESSAGE/SWEEP's
    // single-value DESTINATION handed the name back to SEND. The SDK then
    // compacted single-recipient SEND destinations that send.js cannot resolve,
    // so every send after the first to a given address was rejected on chain.
    it('SEND never compacts DESTINATION: it is multi-value and send.js cannot resolve a ^id', function () {
        assert.ok(!SDK_COMPACTABLE_BY_ACTION.SEND.includes('DESTINATION'),
            'SEND.DESTINATION must never be compacted');
        assert.deepStrictEqual(SDK_COMPACTABLE_BY_ACTION.SEND, []);
    });

    it('no action may compact a field it declares multi, listType or noCompact', function () {
        for (const [action, specs] of Object.entries(ADDRESS_REF_FIELDS)) {
            const allowed = SDK_COMPACTABLE_BY_ACTION[action] || [];
            for (const spec of specs) {
                if (spec.multi || spec.listType || spec.noCompact) {
                    assert.ok(!allowed.includes(spec.field),
                        `${action}.${spec.field} is held back but appears in its compactable set`);
                }
            }
        }
    });

    // The structural guard against the whole class: a field name shared by two
    // actions must not carry one action's permission into the other.
    it('every compactable field is declared BY THAT ACTION', function () {
        for (const [action, allowed] of Object.entries(SDK_COMPACTABLE_BY_ACTION)) {
            const own = new Set((ADDRESS_REF_FIELDS[action] || []).map((s) => s.field));
            for (const f of allowed) {
                assert.ok(own.has(f),
                    `${action} may compact ${f}, which it does not declare`);
            }
        }
    });

    it('SDK_COMPACTABLE is a subset of the fields declared in the map', function () {
        const declared = new Set();
        for (const specs of Object.values(ADDRESS_REF_FIELDS))
            for (const s of specs) declared.add(s.field);
        for (const f of SDK_COMPACTABLE)
            assert.ok(declared.has(f), `${f} must be a declared address field`);
    });
});
