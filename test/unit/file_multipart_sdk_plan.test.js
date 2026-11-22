'use strict';

// The rail suite and wallet quotes call sdk.planMultipartFile; the planner lives in
// src/file/multipart.js, so the public instance must expose it and answer the same plan.
const assert = require('assert');
const crypto = require('crypto');
const walletAndMessages = require('../../src/XChainSDK/wallet_and_messages.js');
const fileMultipart = require('../../src/file/multipart.js');

describe('sdk.planMultipartFile is public', function () {
    it('is a method on the SDK instance mixin', function () {
        assert.strictEqual(typeof walletAndMessages.planMultipartFile, 'function');
    });

    it('answers the planner result for the same bytes and options', async function () {
        const bytes = crypto.randomBytes(20000);
        const meta = { name: 'plan.bin', type: 'application/octet-stream' };
        const viaSdk = await walletAndMessages.planMultipartFile.call({}, bytes, meta, {});
        const direct = await fileMultipart.planMultipartFile(bytes, meta, {});
        assert.strictEqual(viaSdk.FILE_HASH, direct.FILE_HASH);
        assert.strictEqual(viaSdk.TOTAL_PARTS, direct.TOTAL_PARTS);
        assert.strictEqual(viaSdk.TOTAL_BYTES, direct.TOTAL_BYTES);
    });
});
