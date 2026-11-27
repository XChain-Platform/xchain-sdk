// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Vite's production build runs @rollup/plugin-commonjs, which resolves every
// literal require in a module, including the bitcoinjs-lib 6 fallback's loads
// that never run under bitcoinjs-lib 7. bip174 3 refuses those internal paths,
// so a literal specifier there stopped every consumer's build (xchain-sdk
// issue 41). This builds a minimal consumer of the patch module the way an app
// would. Running the bundle needs each app's own shims for the SDK's Node and
// ESM edges, so the check stops at a clean production build.
const SDK_ROOT = path.resolve(__dirname, '../../..');
const PATCH_ENTRY = path.join(SDK_ROOT, 'src/utils/apply_bufferutils_patch.js');

describe('the bufferutils patch builds and loads under Vite', function () {
    this.timeout(120000);
    let workDir;

    before(function () {
        workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-sdk-vite-'));
    });

    after(function () {
        if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
    });

    it('bundles without resolving the bitcoinjs-lib 6 only bip174 internals', async function () {
        const { build } = await import('vite');
        fs.writeFileSync(path.join(workDir, 'main.js'),
            `import bufferutils from ${JSON.stringify(PATCH_ENTRY)};\n` +
            'export const readUInt64 = bufferutils.BufferReader.prototype.readUInt64;\n');
        // The SDK sits outside the consumer's node_modules here, so the
        // commonjs transform is pointed at it the way a linked install sees it.
        const sdkPath = new RegExp(SDK_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\\\/]');
        await build({
            root: workDir,
            configFile: false,
            logLevel: 'silent',
            build: {
                outDir: path.join(workDir, 'dist'),
                minify: false,
                lib: { entry: path.join(workDir, 'main.js'), formats: ['es'], fileName: 'app' },
                commonjsOptions: { include: [sdkPath, /node_modules/] },
            },
        });

        const bundle = fs.readdirSync(path.join(workDir, 'dist')).find((f) => /\.m?js$/.test(f));
        expect(bundle, 'the build wrote a bundle').to.be.a('string');
        const code = fs.readFileSync(path.join(workDir, 'dist', bundle), 'utf8');
        expect(code).to.not.include('bip174/src/lib/converter');
        expect(code).to.include('readUInt64');
    });
});
