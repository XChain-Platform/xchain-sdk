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
 * : the registry must not reach for a filesystem that is not there.
 *
 * The regtest FULLNODE sidecar is a file on a developer's disk. This module is
 * also bundled into browsers - the wallet's web, extension and both mobile
 * shells all ship it - and there `fs` and `path` are shims. `path.resolve` was
 * undefined, so resolving a regtest config threw a TypeError on every launch of
 * both mobile shells, and the catch turned it into a console line reading
 * "FULLNODE regtest sidecar ignored: r.resolve is not a function".
 *
 * Nothing broke, which is what made it survive: it was a dev/full-node code
 * path executing, and announcing itself, in a build headed for an app store.
 *
 * These tests simulate that environment the only way that is honest here - by
 * removing the member the guard checks - because a bundler shim is precisely a
 * `process`/`path` that EXISTS while the function we call does not.
 *
 ********************************************************************/

const assert = require('assert');

const coins = require('../../src/coins');

describe('coin registry without a filesystem ', function(){

    // Capture console.log around a call, since the defect's whole visible
    // symptom was a log line rather than a thrown error.
    function withCapturedLog(fn){
        const lines = [];
        const original = console.log;
        console.log = (...args) => { lines.push(args.join(' ')); };
        try { return { value: fn(), lines }; }
        finally { console.log = original; }
    }

    // A bundler shim is `process` present, `process.cwd` absent. Removing the
    // method is therefore a truer simulation than deleting the global, which
    // would also break mocha.
    function withoutProcessCwd(fn){
        const original = process.cwd;
        delete process.cwd;
        try { return fn(); }
        finally { process.cwd = original; }
    }

    it('resolves a regtest config with no filesystem, silently', function(){
        const { value, lines } = withCapturedLog(() => withoutProcessCwd(
            () => coins.getCoinConfig('BTC', 'regtest'),
        ));

        assert.ok(value, 'a regtest config is still returned');
        assert.ok(value.FULLNODE, 'FULLNODE is still resolved from the bundled defaults');
        assert.deepStrictEqual(
            lines.filter((l) => /sidecar/i.test(l)),
            [],
            'no sidecar complaint reaches the console: before the guard this said'
            + ' "FULLNODE regtest sidecar ignored: r.resolve is not a function"',
        );
    });

    it('leaves the internal $-descriptors stripped either way', function(){
        const withFs = coins.getCoinConfig('BTC', 'regtest');
        const withoutFs = withoutProcessCwd(() => coins.getCoinConfig('BTC', 'regtest'));

        // The guard must skip only the sidecar READ, never the resolution around
        // it: a browser that silently got a differently-shaped config would be a
        // worse bug than the log line this fixes.
        assert.deepStrictEqual(
            Object.keys(withoutFs.FULLNODE).sort(),
            Object.keys(withFs.FULLNODE).sort(),
            'the same FULLNODE keys resolve with and without a filesystem',
        );
        for(const key of Object.keys(withoutFs.FULLNODE)){
            assert.ok(!key.startsWith('$'), `internal descriptor ${key} was stripped`);
        }
    });

    it('still reads the sidecar under a real Node, so the guard is not a mute button', function(){
        const fs = require('fs');
        const path = require('path');
        const sidecar = path.resolve(process.cwd(), 'fullnode.regtest.json');
        const preexisting = fs.existsSync(sidecar);
        if(preexisting) this.skip();

        // A value no bundled default carries, so its presence can only come from
        // the file. This is what proves the Node path is untouched: a guard that
        // was too broad would pass every test above and quietly break regtest.
        fs.writeFileSync(sidecar, JSON.stringify({ XC1016_PROBE: 'read-from-disk' }));
        try {
            const cfg = coins.getCoinConfig('BTC', 'regtest');
            assert.strictEqual(
                cfg.FULLNODE.XC1016_PROBE,
                'read-from-disk',
                'Node still merges the regtest sidecar',
            );
        } finally {
            fs.unlinkSync(sidecar);
        }
    });

    it('mainnet never consults a sidecar at all, filesystem or not', function(){
        const { lines } = withCapturedLog(() => withoutProcessCwd(
            () => coins.getCoinConfig('BTC', 'mainnet'),
        ));
        assert.deepStrictEqual(lines.filter((l) => /sidecar/i.test(l)), []);
    });
});
