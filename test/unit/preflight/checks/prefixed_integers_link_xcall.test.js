'use strict';

const { expect } = require('chai');
const {
    PREFIXED_INTEGER_FIELDS, checkPrefixedIntegers,
} = require('../../../../src/preflight/universal/prefixed_integers.js');

// A stub ctx records the findings checkPrefixedIntegers adds, so the check is driven alone.
function run(action, version, params) {
    const findings = [];
    const ctx = { params, markRun() {}, addFinding(code, severity, message, data) {
        findings.push({ code, severity, message, data });
    } };
    checkPrefixedIntegers(ctx, { action, version });
    return findings;
}

const PREFIXED = ['0x10', '0b101', '0o17'];
const CASES = [
    ['LINK', 0, 'COIN1_ACTION_INDEX', { COIN1_ACTION_INDEX: null, COIN2_ACTION_INDEX: '5' }],
    ['LINK', 0, 'COIN2_ACTION_INDEX', { COIN1_ACTION_INDEX: '0', COIN2_ACTION_INDEX: null }],
    ['XCALL', 0, 'TARGET_CONTRACT_INDEX', { TARGET_CONTRACT_INDEX: null }],
];

describe('preflight prefixed integers: LINK and XCALL', function () {
    it('lists LINK and XCALL', function () {
        expect(PREFIXED_INTEGER_FIELDS.LINK[0]).to.have.members(['COIN1_ACTION_INDEX', 'COIN2_ACTION_INDEX']);
        expect(PREFIXED_INTEGER_FIELDS.XCALL[0]).to.deep.equal(['TARGET_CONTRACT_INDEX']);
    });

    for (const [action, version, field, base] of CASES) {
        const withValue = (value) => Object.assign({}, base, { [field]: value });
        for (const value of PREFIXED) {
            it(`refuses ${action} ${field} ${value} as a halt-class format error`, function () {
                const found = run(action, version, withValue(value));
                expect(found).to.have.length(1);
                expect(found[0]).to.include({ code: 'VALIDATOR_SEMANTICS', severity: 'error' });
                expect(found[0].data).to.include({ field, value, haltClass: true, verdict: `invalid: ${field} (format)` });
            });
        }
        it(`leaves ${action} ${field} decimal and past-range literals alone`, function () {
            expect(run(action, version, withValue('16'))).to.deep.equal([]);
            expect(run(action, version, withValue('0x10000000000000000'))).to.deep.equal([]);
        });
    }
});
