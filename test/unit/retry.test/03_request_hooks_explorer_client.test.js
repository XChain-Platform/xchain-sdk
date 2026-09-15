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
const ExplorerClient = require('../../../src/clients/explorer.js');


// Request hook tests

function registerExplorerSuccessHookTests(getClient, getLog, explorerBase) {
    it('onRequest fires before each request', async () => {
        nock(explorerBase)
            .get('/BTC/api/status').reply(200, { ok: true });

        await getClient().getStatus();
        let req = getLog().find(e => e.type === 'request');
        expect(req).to.exist;
        expect(req.service).to.equal('explorer');
    });

    it('onResponse fires on success with status 200', async () => {
        nock(explorerBase)
            .get('/BTC/api/status').reply(200, { ok: true });

        await getClient().getStatus();
        let res = getLog().find(e => e.type === 'response');
        expect(res).to.exist;
        expect(res.status).to.equal(200);
    });
}

function registerExplorerErrorHookTests(getClient, getLog, explorerBase) {
    it('onError fires on HTTP error', async () => {
        nock(explorerBase)
            .get('/BTC/api/status').reply(500, { error: 'server error' });

        try { await getClient().getStatus(); } catch (_) {}
        let errEntry = getLog().find(e => e.type === 'error');
        expect(errEntry).to.exist;
    });

    it('hook info includes service: explorer and method: GET', async () => {
        nock(explorerBase)
            .get('/BTC/api/status').reply(200, { ok: true });

        await getClient().getStatus();
        let req = getLog().find(e => e.type === 'request');
        expect(req.service).to.equal('explorer');
        expect(req.method).to.equal('GET');
    });

    it('no hooks configured: no crash on successful request', async () => {
        let noHookClient = new ExplorerClient({
            network:     'bitcoin-mainnet',
            explorerUrl: 'hooks.test',
            explorerPort: 8080,
            retry: false
        });

        nock(explorerBase)
            .get('/BTC/api/status').reply(200, { ok: true });

        let result = await noHookClient.getStatus();
        expect(result).to.deep.equal({ ok: true });
    });
}

describe('request hooks - ExplorerClient', () => {
    const EXPLORER_BASE = 'http://hooks.test:8080';
    let log;
    let client;

    beforeEach(() => {
        log = [];
        client = new ExplorerClient({
            network:     'bitcoin-mainnet',
            explorerUrl: 'hooks.test',
            explorerPort: 8080,
            retry: false,
            hooks: {
                onRequest:  (info) => log.push({ type: 'request',  ...info }),
                onResponse: (info) => log.push({ type: 'response', ...info }),
                onError:    (info) => log.push({ type: 'error',    ...info })
            }
        });
    });

    afterEach(() => {
        nock.cleanAll();
    });

    registerExplorerSuccessHookTests(() => client, () => log, EXPLORER_BASE);
    registerExplorerErrorHookTests(() => client, () => log, EXPLORER_BASE);

});
