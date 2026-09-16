'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pre-flight engine suite: modes, input normalization, report shape,
// tier precedence, and the severity/trust model (spec §4.1-4.3).

const { expect } = require('chai');
const { mockSdk } = require('../helpers/mock.js');
const { SDKFormatError, SDKPreflightError } = require('../../../../src/utils/errors.js');
const { normalizeInput } = require('../../../../src/preflight/index.js');
const Actions = require('../../../../src/actions/index.js');
const Utility = require('../../../../src/utils/utility.js');
// A real compose core, built directly rather than off mockSdk (which is a
// bare {config} shim): these cases compare the TWO CONSUMERS of that core,
// so the mock plumbing should not sit between them.
const core = new Actions({ config: {}, util: new Utility() });
// Real addresses: createAction VALIDATES and pre-flight does not, so a
// placeholder would fail only one side and mask the comparison.
const A1 = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';
const A2 = '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2';

function registerBasicInputNormalization() {
    describe('input normalization', function () {
        it('unparseable string throws SDKFormatError, not SDKPreflightError', async function () {
            const sdk = mockSdk();
            let err;
            try { await sdk.preflight('!!!garbage', { preflight: 'local' }); } catch (e) { err = e; }
            expect(err).to.be.instanceof(SDKFormatError);
            expect(err).to.not.be.instanceof(SDKPreflightError);
        });

        it('accepts a ParsedAction directly', async function () {
            const { parse } = require('../../../../src/decoder/parse.js');
            const sdk = mockSdk();
            const r = await sdk.preflight(parse('MINT|0|JDOG|5'), { source: 's', preflight: 'local' });
            expect(r).to.have.property('verdict');
        });

        it('accepts an {action, params} object', async function () {
            const sdk = mockSdk();
            const r = await sdk.preflight({ action: 'SEND', params: { TICK: 'JDOG', AMOUNT: '1', DESTINATION: 'x' } }, { source: 's', preflight: 'local' });
            expect(r).to.have.property('verdict');
        });
    });
}

function registerCamelCaseInputNormalization() {
    describe('input normalization', function () {
        // The case above used canonical UPPER_SNAKE keys, which is why this
        // gap survived: createAction takes camelCase and normalizes it, so the
        // very same object that composes fine threw UNENCODABLE_INPUT out of
        // pre-flight. A headless consumer on the default 'enforce' mode got an
        // exception where §4.2 promises a verdict. Caught the first time the
        // §8.2 harness ran against a real chain.
        it('accepts camelCase params, exactly as createAction does', async function () {
            const sdk = mockSdk();
            const r = await sdk.preflight(
                { action: 'SEND', params: { tick: 'JDOG', amount: '1', destination: 'x' } },
                { source: 's', preflight: 'local' },
            );
            expect(r).to.have.property('verdict');
        });

        // createAction lets a caller force a format version via params.version
        // (ISSUE create vs edit, STAKE v1 vs v2). Pre-flight read only a
        // top-level version, so a params-level one stayed behind as a bogus
        // VERSION field and an owner's ISSUE EDIT could not be pre-flighted at
        // all. Also found by the §8.2 harness on its first real run.
        it('honours a version forced through params, as createAction does', async function () {
            const sdk = mockSdk();
            const r = await sdk.preflight(
                { action: 'ISSUE', params: { tick: 'JDOG', version: 1, description: 'updated' } },
                { source: 's', preflight: 'local' },
            );
            expect(r).to.have.property('verdict');
        });

        it('normalizes camelCase to the same report as UPPER_SNAKE', async function () {
            const sdk = mockSdk();
            const opts = { source: 's', preflight: 'local' };
            const upper = await sdk.preflight({ action: 'SEND', params: { TICK: 'JDOG', AMOUNT: '1', DESTINATION: 'x' } }, opts);
            const camel = await sdk.preflight({ action: 'SEND', params: { tick: 'JDOG', amount: '1', destination: 'x' } }, opts);
            // Same action in two spellings must not produce two verdicts.
            expect(camel.verdict).to.equal(upper.verdict);
            expect(camel.checksRun).to.deep.equal(upper.checksRun);
        });
    });
}

function registerSharedComposeCoreCases() {
    // The three cases above were each fixed one at a time, because
    // pre-flight re-implemented a SUBSET of createAction's params ->
    // wire-string core. The cases below pin the unification itself:
    // both entry points call Actions.composeActionString, so a
    // behaviour added there cannot reach one caller and not the other.
    describe('input normalization', function () {
        describe('shares ONE compose core with createAction', function () {

            // The anti-drift assertion. Everything else here is a symptom;
            // this is the property. If these two ever disagree, pre-flight is
            // judging a different action than the one that would broadcast.
            const SAME = [
                ['SEND camelCase',   { action: 'SEND',  params: { tick: 'JDOG', amount: '1', destination: A1 } }],
                ['SEND UPPER_SNAKE', { action: 'SEND',  params: { TICK: 'JDOG', AMOUNT: '1', DESTINATION: A1 } }],
                ['ISSUE forced v1',  { action: 'ISSUE', params: { tick: 'JDOG', version: 1, description: 'updated' } }],
                ['LIST lone item',   { action: 'LIST',  params: { type: 1, item: 'TOKEN1,TOKEN2' } }],
            ];

            SAME.forEach(([label, input]) => {
                it(`derives the same wire string as createAction: ${label}`, function () {
                    const viaCompose  = core.createAction(input).actionString;
                    const viaPreflight = normalizeInput(input, core).actionString;
                    expect(viaPreflight).to.equal(viaCompose);
                });
            });

            // LEGS landed in createAction (multi-leg SEND) while the
            // duplicate path was still live, so it is the behaviour that was
            // next in line to be silently forgotten. It is exercised here as
            // the concrete instance of the general property above.
            it('normalizes LEGS, which the duplicated path never did', function () {
                const sdk = mockSdk();
                const input = {
                    action: 'SEND',
                    params: { tick: 'JDOG', legs: [{ amount: '1', destination: A1 },
                                                   { amount: '2', destination: A2 }] },
                };
                const viaPreflight = normalizeInput(input, core).actionString;
                expect(viaPreflight).to.equal(core.createAction(input).actionString);
                // Both legs must actually reach the wire; the bug this fixed
                // re-emitted leg 1 twice, which is well-formed and wrong.
                expect(viaPreflight).to.contain(A1);
                expect(viaPreflight).to.contain(A2);
            });
        });
    });
}

function registerComposeCoreDifferences() {
    describe('input normalization', function () {
        describe('shares ONE compose core with createAction', function () {
            // A top-level `version` is pre-flight's spelling, params.VERSION is
            // createAction's. Both are read by the shared core, so the two
            // spellings must select the same format.
            it('reads a top-level version and a params VERSION identically', function () {
                const sdk = mockSdk();
                const topLevel = normalizeInput({ action: 'ISSUE', version: 1, params: { tick: 'JDOG', description: 'updated' } }, core);
                const inParams = normalizeInput({ action: 'ISSUE', params: { tick: 'JDOG', version: 1, description: 'updated' } }, core);
                expect(topLevel.actionString).to.equal(inParams.actionString);
                expect(topLevel.version).to.equal(1);
            });

            // The one deliberate difference between the callers, kept as a
            // parameter rather than a divergence: compose throws on invalid
            // fields, pre-flight must still return a verdict (spec §4.2), or a
            // headless consumer gets an exception where it expected a report.
            it('does NOT throw on fields createAction would reject', async function () {
                const sdk = mockSdk();
                const bad = { action: 'SEND', params: { tick: 'JDOG', amount: '-5', destination: 'x' } };
                expect(() => core.createAction(bad)).to.throw();
                const r = await sdk.preflight(bad, { source: 's', preflight: 'local' });
                expect(r).to.have.property('verdict');
            });
        });
    });
}

describe('pre-flight engine', function () {
    registerBasicInputNormalization();
    registerCamelCaseInputNormalization();
    registerSharedComposeCoreCases();
    registerComposeCoreDifferences();
});
