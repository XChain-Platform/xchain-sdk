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
const nock = require('nock');
const sinon = require('sinon');
const EncoderClient = require('../../../src/clients/encoder.js');

describe('EncoderClient', function () {
    const BASE = 'http://encoder.test:3000';

    afterEach(function () {
        nock.cleanAll();
    });

    describe('hooks', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('fires onRequest hook', async function () {
            const onRequest = sinon.spy();
            const hooked = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: false,
                hooks: { onRequest }
            });
            nock(BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { status: 'ok' }, id: 1 });

            await hooked.ping();
            expect(onRequest.calledOnce).to.be.true;
            expect(onRequest.firstCall.args[0].service).to.equal('encoder');
            expect(onRequest.firstCall.args[0].method).to.equal('ping');
        });
    });
});

describe('EncoderClient', function () {
    const BASE = 'http://encoder.test:3000';

    afterEach(function () {
        nock.cleanAll();
    });

    describe('hooks', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('fires onResponse hook', async function () {
            const onResponse = sinon.spy();
            const hooked = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: false,
                hooks: { onResponse }
            });
            nock(BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { status: 'ok' }, id: 1 });

            await hooked.ping();
            expect(onResponse.calledOnce).to.be.true;
            expect(onResponse.firstCall.args[0].service).to.equal('encoder');
        });
    });
});

describe('EncoderClient', function () {
    const BASE = 'http://encoder.test:3000';

    afterEach(function () {
        nock.cleanAll();
    });

    describe('hooks', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('fires onError hook on RPC error', async function () {
            const onError = sinon.spy();
            const hooked = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: false,
                hooks: { onError }
            });
            nock(BASE)
                .post('/')
                .reply(200, { jsonrpc: '2.0', error: { code: -1, message: 'oops' }, id: 1 });

            try {
                await hooked.ping();
            } catch (e) {
                // expected
            }
            expect(onError.calledOnce).to.be.true;
            expect(onError.firstCall.args[0].service).to.equal('encoder');
        });
    });
});

describe('EncoderClient', function () {
    const BASE = 'http://encoder.test:3000';

    afterEach(function () {
        nock.cleanAll();
    });

    describe('hooks', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('fires onError hook on network error', async function () {
            const onError = sinon.spy();
            const hooked = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: false,
                hooks: { onError }
            });
            nock(BASE)
                .post('/')
                .replyWithError('connection reset');

            try {
                await hooked.ping();
            } catch (e) {
                // expected
            }
            expect(onError.calledOnce).to.be.true;
        });
    });
});

describe('EncoderClient', function () {
    const BASE = 'http://encoder.test:3000';

    afterEach(function () {
        nock.cleanAll();
    });

    describe('hooks', function () {
        afterEach(function () {
            sinon.restore();
        });

        it('fires onRetry hook on retryable error', async function () {
            const onRetry = sinon.spy();
            const hooked = new EncoderClient({
                encoderUrl: 'encoder.test',
                encoderPort: 3000,
                retry: { maxRetries: 1, baseDelay: 0, maxDelay: 0, backoffFactor: 1 },
                hooks: { onRetry }
            });

            // First call fails with 503 (retryable), second succeeds
            nock(BASE)
                .post('/')
                .reply(503, 'Service Unavailable')
                .post('/')
                .reply(200, { jsonrpc: '2.0', result: { status: 'ok' }, id: 1 });

            await hooked.ping();
            expect(onRetry.calledOnce).to.be.true;
            expect(onRetry.firstCall.args[0].service).to.equal('encoder');
        });
    });
});
