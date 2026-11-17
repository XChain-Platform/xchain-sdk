'use strict';

const assert = require('node:assert');
const { expect } = require('chai');
const { sendInWindow } = require('../../../src/file/multipart_funding.js');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((accept, refuse) => {
        resolve = accept;
        reject = refuse;
    });
    return { promise, resolve, reject };
}

function flush() {
    return new Promise(resolve => setImmediate(resolve));
}

describe('multipart send window', function () {
    it('starts 30 items in order without exceeding a limit of 8', async function () {
        const items = Array.from({ length: 30 }, (_, index) => index);
        const started = [];
        let pending = 0;
        let highWater = 0;

        const results = await sendInWindow(items, 8, async (item, index) => {
            started.push(index);
            pending += 1;
            highWater = Math.max(highWater, pending);
            await new Promise(resolve => setTimeout(resolve, (index % 3) + 1));
            pending -= 1;
            return item * 2;
        });

        expect(started).to.deep.equal(items);
        expect(highWater).to.equal(8);
        expect(results).to.deep.equal(items.map(item => item * 2));
    });

    it('returns results in item order when workers finish out of order', async function () {
        const calls = Array.from({ length: 6 }, deferred);
        const finished = [];
        const operation = sendInWindow([0, 1, 2, 3, 4, 5], 3, async (item, index) => {
            const result = await calls[index].promise;
            finished.push(index);
            return result;
        });

        for (const index of [2, 3, 1, 4, 5, 0]) {
            calls[index].resolve('result-' + index);
            await flush();
        }

        expect(finished).to.deep.equal([2, 3, 1, 4, 5, 0]);
        expect(await operation).to.deep.equal([
            'result-0', 'result-1', 'result-2', 'result-3', 'result-4', 'result-5'
        ]);
    });

    it('stops starting items after a rejection and waits for pending workers', async function () {
        const calls = Array.from({ length: 8 }, deferred);
        const failure = new Error('item 3 failed');
        const started = [];
        let settled = false;
        const operation = sendInWindow([0, 1, 2, 3, 4, 5, 6, 7], 5, (item, index) => {
            started.push(index);
            if (index === 3) return Promise.reject(failure);
            return calls[index].promise;
        });
        operation.then(() => { settled = true; }, () => { settled = true; });

        await flush();
        expect(started).to.deep.equal([0, 1, 2, 3, 4]);
        expect(settled).to.equal(false);

        for (const index of [0, 1, 2, 4]) calls[index].resolve(index);
        await assert.rejects(operation, error => error === failure);
        expect(started).to.deep.equal([0, 1, 2, 3, 4]);
        expect(settled).to.equal(true);
    });

    it('refuses invalid limits before starting a worker', async function () {
        let calls = 0;
        const worker = () => { calls += 1; };

        for (const limit of [0, 1.5])
            await assert.rejects(() => sendInWindow([1], limit, worker), /limit/);
        expect(calls).to.equal(0);
    });
});
