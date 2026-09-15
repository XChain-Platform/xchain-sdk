// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Output parity for the SDK's one logger. The SDK is a library whose callers
// already read its console output (process managers, the wallet's smoke
// suites, this repo's own console swaps), so the default sink must be
// indistinguishable from a direct console call: same stream, same bytes,
// same order, for every level and every argument shape console formats
// differently. The proof here is a byte compare of what process.stdout and
// process.stderr received from console.<level>(...args) against what they
// received from getLogger().<level>(...args) with the same args.

const assert = require('assert');

const { getLogger, setSink, LEVELS } = require('../../../src/observability/logger.js');

// Record every chunk either stream receives while fn runs, as [stream, text]
// pairs so cross-stream order is part of the record; both writes are restored
// in finally so a failing assertion cannot mute the reporter.
function capture(fn) {
    const out = [];
    const origOut = process.stdout.write;
    const origErr = process.stderr.write;
    process.stdout.write = (chunk) => { out.push(['stdout', String(chunk)]); return true; };
    process.stderr.write = (chunk) => { out.push(['stderr', String(chunk)]); return true; };
    try { fn(); } finally {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
    }
    return out;
}

// One entry per formatting path console takes (printf substitution, Error
// stacks, inspect of nested and circular objects, spaced primitives, Buffer,
// empty call); factories so both sides of a compare share one Error stack.
const CASES = [
    ['bare string', () => ['Hub config loaded successfully']],
    ['string plus error message', () => ['Hub unavailable, using explicit/default config:', 'ECONNREFUSED']],
    ['printf substitution', () => ['SDK API: docs/openrpc.json is unreadable (%s); /openrpc.json will answer 503', 'ENOENT']],
    ['printf mixed specifiers', () => ['%s=%d %o %j %%', 'k', 42, { a: [1, 2] }, { b: 'c' }]],
    ['error object', (() => { const e = new Error('boom'); e.code = 'E_TEST'; return () => ['x402 sweep: cycle failed:', e]; })()],
    ['nested object and array', () => ['ctx', { a: 1, b: { c: [1, 2, { d: null }] }, e: undefined }]],
    ['mixed primitives', () => ['n', 1, 2.5, -0, null, undefined, true, 10n, 'tail']],
    ['buffer', () => ['buf', Buffer.from('xchain')]],
    ['circular object', (() => { const o = { name: 'loop' }; o.self = o; return () => ['circ', o]; })()],
    ['no arguments', () => []],
    ['non-string first argument', () => [{ level: 'first' }, 'second']],
    ['template with context or empty string', () => ['[cosigner] taking over a stale lock', '']],
];

describe('observability/logger default sink parity', () => {
    afterEach(() => { setSink(null); });

    it('exposes exactly the console methods the SDK routes through it', () => {
        assert.deepStrictEqual([...LEVELS], ['log', 'info', 'warn', 'error', 'debug']);
        const log = getLogger('parity');
        for (const level of LEVELS) assert.strictEqual(typeof log[level], 'function', level);
        assert.strictEqual(typeof console.trace, 'function');
        assert.strictEqual(log.trace, undefined, 'trace is not offered: its stack would differ');
    });

    for (const level of LEVELS) {
        describe(`level ${level}`, () => {
            for (const [label, makeArgs] of CASES) {
                it(`writes the same bytes to the same stream as console.${level} for ${label}`, () => {
                    const args = makeArgs();
                    const direct = capture(() => console[level](...args));
                    const routed = capture(() => getLogger('parity')[level](...args));
                    assert.ok(direct.length > 0, 'console wrote nothing, the capture is not observing');
                    assert.deepStrictEqual(routed, direct);
                });
            }

            it(`reaches a console.${level} swapped in after the logger was built`, () => {
                const log = getLogger('parity');
                const seen = [];
                const original = console[level];
                console[level] = (...args) => { seen.push(args); };
                try { log[level]('swapped', { n: 1 }); } finally { console[level] = original; }
                assert.deepStrictEqual(seen, [['swapped', { n: 1 }]]);
            });
        });
    }

    it('uses stderr for warn and error and stdout for log, info and debug', () => {
        const streams = {};
        for (const level of LEVELS) {
            const rec = capture(() => getLogger('parity')[level]('stream check'));
            streams[level] = rec.map(([s]) => s);
        }
        assert.deepStrictEqual(streams, {
            log: ['stdout'], info: ['stdout'], debug: ['stdout'], warn: ['stderr'], error: ['stderr'],
        });
    });
});

describe('observability/logger programmatic sink', () => {
    afterEach(() => { setSink(null); });

    it('returns the same frozen logger for the same name', () => {
        const a = getLogger('same');
        const b = getLogger('same');
        assert.strictEqual(a, b);
        assert.strictEqual(a.name, 'same');
        assert.ok(Object.isFrozen(a));
        assert.notStrictEqual(getLogger('other'), a);
        assert.strictEqual(getLogger().name, 'xchain-sdk');
    });

    it('routes every level to the installed sink with the untouched arguments and bypasses console', () => {
        const calls = [];
        const previous = setSink((level, name, args) => { calls.push([level, name, args]); });
        assert.strictEqual(previous, null);
        const log = getLogger('sinked');
        const err = new Error('e');
        const rec = capture(() => {
            log.log('a', 1);
            log.info('b', { x: 1 });
            log.warn('c');
            log.error('d', err);
            log.debug();
        });
        assert.deepStrictEqual(rec, [], 'nothing reached the streams while a sink was installed');
        assert.deepStrictEqual(calls, [
            ['log', 'sinked', ['a', 1]],
            ['info', 'sinked', ['b', { x: 1 }]],
            ['warn', 'sinked', ['c']],
            ['error', 'sinked', ['d', err]],
            ['debug', 'sinked', []],
        ]);
        assert.strictEqual(calls[3][2][1], err, 'the Error instance is passed by reference, not rendered');
    });
});

describe('observability/logger sink lifecycle', () => {
    afterEach(() => { setSink(null); });

    it('applies to loggers obtained before the sink was installed', () => {
        const early = getLogger('early');
        const seen = [];
        setSink((level, name, args) => { seen.push([level, name, ...args]); });
        capture(() => early.warn('late bound'));
        assert.deepStrictEqual(seen, [['warn', 'early', 'late bound']]);
    });

    it('restores the default sink with null and hands back the previous sink', () => {
        const mine = () => {};
        setSink(mine);
        const got = setSink(null);
        assert.strictEqual(got, mine);
        const direct = capture(() => console.warn('restored', 1));
        const routed = capture(() => getLogger('restored').warn('restored', 1));
        assert.deepStrictEqual(routed, direct);
    });

    it('rejects a sink that is neither a function nor null', () => {
        assert.throws(() => setSink('json'), TypeError);
        assert.throws(() => setSink({}), TypeError);
        const direct = capture(() => console.log('still default'));
        const routed = capture(() => getLogger('reject').log('still default'));
        assert.deepStrictEqual(routed, direct);
    });

    it('reads no environment variable', () => {
        const src = require('fs').readFileSync(require.resolve('../../../src/observability/logger.js'), 'utf8');
        assert.ok(!/process\.env/.test(src), 'the logger must not consult process.env');
    });
});
