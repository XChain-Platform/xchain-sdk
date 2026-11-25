'use strict';

const assert = require('assert');
const { WORKFLOW, FILE_HASH, dependencyStubs, plan, installDependencies, makeSdk, wireAction, publishWith,
    typedAddresses } = require('../helpers/multipart_publish_stubs.js');

describe('publishMultipartFile resume', function () {
    let restore;
    afterEach(function () { if (restore) restore(); restore = null; });

    it('skips an on-chain part and funds only the missing part plus manifest', async function () {
        const stubs = dependencyStubs();
        restore = installDependencies(stubs);
        const workflow = require(WORKFLOW);
        const { sdk, calls } = makeSdk();
        sdk.waitForFileComplete = (index, opts) => workflow.waitForFileComplete.call(sdk, index, opts);
        const progress = [];
        const bytes = Buffer.from('file');
        const originalSha256 = require('crypto').createHash('sha256').update(bytes).digest('hex');
        const result = await workflow.publishMultipartFile.call(sdk, 'wif', Buffer.from('file'), {}, {
            activationTime: 100, sourceType: 'p2pkh', pieceFundingValues: [40, 41],
            maxFeeSats: 123, maxPhaseFundingSats: 456,
            resumeRecord: { originalSha256, fileHash: FILE_HASH, totalParts: 2 },
            onChainPieces: [{ kind: 'part', fileHash: FILE_HASH, partIndex: 0,
                partDigest: '0'.repeat(64), actionIndex: 1 }],
            onProgress: step => progress.push(step), pollInterval: 1,
        });
        assert.strictEqual(result.actionIndex, 50);
        assert.strictEqual(result.originalSha256, originalSha256);
        assert.strictEqual(calls.submissions.length, 2);
        assert(calls.submissionOptions.every(call => call.lifecycle.maxFeeSats === 123));
        assert(calls.submissionOptions.every(call => call.lifecycle.maxPhaseFundingSats === 456));
        assert.deepStrictEqual(calls.creates[0].customOutputs.map(output => output.value), [40, 41]);
        assert(progress.includes('piece_skipped'));
        assert(progress.includes('complete'));
    });
});

describe('publishMultipartFile activation', function () {
    let restore;
    afterEach(function () { if (restore) restore(); restore = null; });

    it('fails closed when getStatus last_block_time is below activation', async function () {
        let planned = false;
        restore = installDependencies(dependencyStubs({
            planMultipartFile: async () => { planned = true; return plan(false); },
        }));
        const workflow = require(WORKFLOW);
        const { sdk } = makeSdk();
        sdk.requireExplorer().getStatus = async () => ({ last_block_time: 99 });
        await assert.rejects(() => workflow.publishMultipartFile.call(sdk, 'wif', Buffer.from('x'), {}, {
            activationTime: 100, sourceType: 'p2pkh', pieceFundingValues: [1, 2, 3],
        }), error => error.code === 'MULTIPART_NOT_ACTIVE');
        assert.strictEqual(planned, false);
    });

    it('fails closed when the newest eleven block median is below activation', async function () {
        restore = installDependencies(dependencyStubs());
        const workflow = require(WORKFLOW);
        const { sdk } = makeSdk();
        sdk.requireExplorer().get = async () => ({ data: Array.from({ length: 11 }, () => ({ block_time: 99 })) });
        await assert.rejects(() => workflow.publishMultipartFile.call(sdk, 'wif', Buffer.from('x'), {}, {
            activationTime: 100, sourceType: 'p2pkh', pieceFundingValues: [1, 2, 3],
        }), error => error.code === 'MULTIPART_NOT_ACTIVE');
    });
});

describe('publishMultipartFile gated two-step envelope', function () {
    let restore;
    afterEach(function () { if (restore) restore(); restore = null; });

    it('sends a FILE and MESSAGE batch and uses commit then reveal builds', async function () {
        const reconciles = [];
        restore = installDependencies(dependencyStubs({
            planMultipartFile: async () => plan(true),
            reconcileEncoded: (psbt, intent) => {
                reconciles.push({ psbt, intent });
                return { phaseFunding: [{ txid: 'phase', vout: 0 }] };
            },
        }));
        const workflow = require(WORKFLOW);
        const { sdk, calls } = makeSdk({ taproot: true, gated: true });
        sdk.waitForFileComplete = (index, opts) => workflow.waitForFileComplete.call(sdk, index, opts);
        const baseSign = sdk.wallet.signPsbt; const commitSigns = [];
        sdk.wallet.signPsbt = (psbt, wif, signOpts) => { if (psbt === 'commit') commitSigns.push(signOpts); return baseSign(psbt, wif); };
        const recoveries = [];
        const result = await workflow.publishMultipartFile.call(sdk, 'wif', Buffer.from('x'), {}, {
            activationTime: 100, sourceType: 'p2pkh', pieceFundingValues: [40, 41, 42],
            maxFeeSats: 123, maxPhaseFundingSats: 456,
            onRecovery: recovery => recoveries.push(recovery), pollInterval: 1,
        });
        assert.deepStrictEqual(calls.batches[0].map(entry => entry.action), ['FILE', 'MESSAGE']);
        const message = calls.batches[0].find(entry => entry.action === 'MESSAGE');
        assert.strictEqual(wireAction(message.action, message.params).split('|')[1], '2');
        assert.strictEqual(calls.creates.filter(call => call.options && call.options.twoStepEnvelope).length, 3);
        const reveals = calls.creates.filter(call => call.options && call.options.envelopeCommitHex);
        assert.strictEqual(reveals.length, 3);
        assert(reveals.every(call => call.options.exactInputs === undefined));
        assert.strictEqual(recoveries.length, 3);
        const actionReconciles = reconciles.filter(call => /^multipart envelope/.test(call.intent.label));
        assert.strictEqual(actionReconciles.length, 9);
        assert(actionReconciles.every(call => call.intent.maxFeeSats === 123));
        assert(actionReconciles.every(call => call.intent.maxPhaseFundingSats === 456));
        assert.deepStrictEqual(commitSigns, [{ inputIndices: [0] }, { inputIndices: [0] }, { inputIndices: [0] }]);
        assert(calls.waitOptions.every(opts => !('maxFeeSats' in opts) && !('maxPhaseFundingSats' in opts)));
        assert.strictEqual(result.actionIndex, 91);
    });

    it('refuses an encoder commit that fails its pre-sign reconcile before signing or sending it', async function () {
        const pre = (psbt, intent) => { if (/pre-sign/.test(intent.label)) throw Object.assign(new Error('cap'), { code: 'FEE_OVER_CAP' }); return { phaseFunding: [] }; };
        restore = installDependencies(dependencyStubs({ planMultipartFile: async () => plan(true), reconcileEncoded: pre }));
        const { sdk, calls } = makeSdk({ taproot: true, gated: true }); const signed = [];
        sdk.wallet.signPsbt = psbt => { signed.push(psbt); return { txHex: 'aa', txid: psbt }; };
        await assert.rejects(() => publishWith(sdk, require(WORKFLOW), { sourceType: 'p2pkh', pieceFundingValues: [40, 41, 42] }), e => e.code === 'FEE_OVER_CAP');
        assert(!signed.includes('commit') && !calls.creates.some(call => call.options && call.options.envelopeCommitHex));
    });
});

describe('waitForFileComplete', function () {
    let restore;
    afterEach(function () { if (restore) restore(); restore = null; });

    it('polls pending assembly until complete and preserves a mismatch verdict', async function () {
        restore = installDependencies(dependencyStubs());
        const workflow = require(WORKFLOW);
        const pending = makeSdk({ assemblies: [{ status: 'pending' }, { status: 'complete' }] });
        const complete = await workflow.waitForFileComplete.call(pending.sdk, 7, { timeout: 50, pollInterval: 1 });
        assert.strictEqual(complete.multipart.status, 'complete');
        const mismatchSdk = makeSdk({ assemblies: [{ status: 'mismatch' }] });
        const mismatch = await workflow.waitForFileComplete.call(mismatchSdk.sdk, 8, { timeout: 50, pollInterval: 1 });
        assert.strictEqual(mismatch.multipart.status, 'mismatch');
    });

    it('fails at once on a locally invalid index but still retries transient errors', async function () {
        restore = installDependencies(dependencyStubs());
        const workflow = require(WORKFLOW);
        let calls = 0;
        const bad = { getFileAssembly: async () => { calls++; const e = new Error('bad index'); e.code = 'INVALID_ACTION_INDEX'; throw e; } };
        const started = Date.now();
        await assert.rejects(() => workflow.waitForFileComplete.call(bad, '0x10', { timeout: 5000, pollInterval: 500 }), e => e.code === 'INVALID_ACTION_INDEX');
        assert(Date.now() - started < 500);
        assert.strictEqual(calls, 1);
        let n = 0;
        const flaky = { getFileAssembly: async () => { if (n++ === 0) { const e = new Error('refused'); e.code = 'ECONNREFUSED'; throw e; } return { status: 'complete' }; } };
        const done = await workflow.waitForFileComplete.call(flaky, 7, { timeout: 500, pollInterval: 1 });
        assert.strictEqual(done.multipart.status, 'complete');
        assert.strictEqual(n, 2);
    });
});

describe('SDK multipart methods', function () {
    it('exposes assembly reads, waits, and publishing delegates', async function () {
        const restore = installDependencies(dependencyStubs());
        try {
            const methods = require('../../src/XChainSDK/wallet_and_messages.js');
            assert.strictEqual(typeof methods.getFileAssembly, 'function');
            assert.strictEqual(typeof methods.waitForFileComplete, 'function');
            assert.strictEqual(typeof methods.publishMultipartFile, 'function');
            const explorer = { getFileAssembly: (index, coin) => ({ index, coin }) };
            const result = await methods.getFileAssembly.call({ requireExplorer: () => explorer }, 4, 'BTC');
            assert.deepStrictEqual(result, { index: 4, coin: 'BTC' });
        } finally { restore(); }
    });
});

describe('publishMultipartFile source type from the source address', function () {
    let restore;
    afterEach(function () { if (restore) restore(); restore = null; });

    it('routes a P2PKH source address to the two-step envelope build', async function () {
        restore = installDependencies(dependencyStubs());
        const workflow = require(WORKFLOW);
        const { sdk, calls } = makeSdk({ taproot: true });
        typedAddresses(sdk);
        const result = await publishWith(sdk, workflow, { sourceAddress: 'p2pkh-address',
            pieceFundingValues: [40, 41, 42] });
        assert.strictEqual(result.source.sourceType, 'p2pkh');
        assert.strictEqual(result.source.buildMode, 'two_step');
        assert.strictEqual(calls.submissions.length, 0);
        assert.strictEqual(calls.creates.filter(call => call.options && call.options.twoStepEnvelope).length, 3);
    });

    it('matches a nested-segwit source address', async function () {
        restore = installDependencies(dependencyStubs());
        const workflow = require(WORKFLOW);
        const { sdk } = makeSdk({ taproot: true });
        typedAddresses(sdk);
        const result = await publishWith(sdk, workflow, { sourceAddress: 'p2sh-p2wpkh-address',
            pieceFundingValues: [40, 41, 42] });
        assert.strictEqual(result.source.sourceType, 'p2sh-p2wpkh');
    });

    it('refuses a source address this key does not derive', async function () {
        restore = installDependencies(dependencyStubs());
        const workflow = require(WORKFLOW);
        const { sdk } = makeSdk({ taproot: true });
        typedAddresses(sdk);
        await assert.rejects(() => publishWith(sdk, workflow, { sourceAddress: 'someone-else',
            pieceFundingValues: [40, 41, 42] }),
        error => error.code === 'MULTIPART_SOURCE_MISMATCH' && /pass opts\.sourceType/.test(error.message));
    });
});

describe('publishMultipartFile reveal pad', function () {
    let restore;
    afterEach(function () { if (restore) restore(); restore = null; });

    async function padFor(coin) {
        const seen = [];
        restore = installDependencies(dependencyStubs({
            pieceFundingValue: args => { seen.push(args.revealPad); return 40 + seen.length - 1; },
        }));
        const workflow = require(WORKFLOW);
        const { sdk } = makeSdk({ taproot: true });
        sdk.requireExplorer().coin = coin;
        await publishWith(sdk, workflow, { sourceType: 'p2wpkh', rate: 1, pairSize: 100 });
        restore();
        restore = null;
        return seen;
    }

    it('asks for the reveal pad on litecoin only', async function () {
        assert.deepStrictEqual(await padFor('RLTC'), [true, true, true]);
        assert.deepStrictEqual(await padFor('RBTC'), [false, false, false]);
    });
});

describe('publishMultipartFile gated manifest action index', function () {
    let restore;
    afterEach(function () { if (restore) restore(); restore = null; });

    it('finds the FILE format 1 row nested in a BATCH reply', async function () {
        restore = installDependencies(dependencyStubs({ planMultipartFile: async () => plan(true) }));
        const workflow = require(WORKFLOW);
        const { sdk } = makeSdk({ taproot: true, gated: true });
        sdk.waitForAction = async () => ({ actions: [{ action: 'BATCH', action_index: 90, actions: [
            { action: 'MESSAGE', action_index: 92 },
            { action: 'FILE', action_format: 1, action_index: 93 },
        ] }] });
        const result = await publishWith(sdk, workflow, { sourceType: 'p2pkh',
            pieceFundingValues: [40, 41, 42] });
        assert.strictEqual(result.actionIndex, 93);
    });
});
