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
 * XChain Platform SDK - Retry Logic & Request Hooks Tests
 *
 ********************************************************************/

const { expect } = require('chai');
const nock = require('nock');
const EncoderClient = require('../../../src/clients/encoder.js');

describe('request hooks - EncoderClient', () => {

    const ENCODER_BASE = 'http://hooks.test:3000';

    let log;
    let client;

    beforeEach(() => {
        log = [];
        client = new EncoderClient({
            encoderUrl:  'hooks.test',
            encoderPort: 3000,
            retry: false,
            hooks: {
                onRequest:  (info) => log.push({ type: 'request',  ...info }),
                onResponse: (info) => log.push({ type: 'response', ...info }),
                onError:    (info) => log.push({ type: 'error',    ...info }),
                onRetry:    (info) => log.push({ type: 'retry',    ...info })
            }
        });
    });

    afterEach(() => {
        nock.cleanAll();
    });

    it('onRequest fires with service: encoder and the RPC method name', async () => {
        nock(ENCODER_BASE)
            .post('/').reply(200, { jsonrpc: '2.0', id: 1, result: 'pong' });

        await client.ping();
        let req = log.find(e => e.type === 'request');
        expect(req).to.exist;
        expect(req.service).to.equal('encoder');
        expect(req.method).to.equal('ping');
    });

    it('onResponse fires on success', async () => {
        nock(ENCODER_BASE)
            .post('/').reply(200, { jsonrpc: '2.0', id: 1, result: 'pong' });

        await client.ping();
        let res = log.find(e => e.type === 'response');
        expect(res).to.exist;
        expect(res.service).to.equal('encoder');
    });

    it('onError fires on RPC error', async () => {
        nock(ENCODER_BASE)
            .post('/').reply(200, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } });

        try { await client.ping(); } catch (_) {}
        let errEntry = log.find(e => e.type === 'error');
        expect(errEntry).to.exist;
        expect(errEntry.service).to.equal('encoder');
    });

    it('onRetry fires on retry', async () => {
        let retryClient = new EncoderClient({
            encoderUrl:  'hooks.test',
            encoderPort: 3000,
            retry: { maxRetries: 1, baseDelay: 10 },
            hooks: {
                onRequest:  (info) => log.push({ type: 'request',  ...info }),
                onResponse: (info) => log.push({ type: 'response', ...info }),
                onError:    (info) => log.push({ type: 'error',    ...info }),
                onRetry:    (info) => log.push({ type: 'retry',    ...info })
            }
        });

        nock(ENCODER_BASE)
            .post('/').reply(503)
            .post('/').reply(200, { jsonrpc: '2.0', id: 2, result: 'pong' });

        await retryClient.ping();
        let retryEntry = log.find(e => e.type === 'retry');
        expect(retryEntry).to.exist;
        expect(retryEntry.service).to.equal('encoder');
    });

    it('no hooks configured: no crash on successful request', async () => {
        let noHookClient = new EncoderClient({
            encoderUrl:  'hooks.test',
            encoderPort: 3000,
            retry: false
        });

        nock(ENCODER_BASE)
            .post('/').reply(200, { jsonrpc: '2.0', id: 1, result: 'pong' });

        let result = await noHookClient.ping();
        expect(result).to.equal('pong');
    });

});
