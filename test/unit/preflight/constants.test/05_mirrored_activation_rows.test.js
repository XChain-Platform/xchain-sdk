'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Cover the drift gate's activation-row leg: pinned tables against the indexer's addGate rows.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const constants = require('../../../../src/preflight/constants.js');
const { checkActivationMirrors } = require('../../../../bin/check-preflight-drift.js');

const { LIST_REFERENCE_VALIDITY: LIST, DISPENSER_SETTLEMENT_PRICE: DISP } = constants.ACTIVATION_MIRRORS;

function row(mirror, over = {}, unit = mirror.unit) {
    const table = Object.assign({}, mirror.table, over);
    const lines = Object.keys(table).filter((k) => table[k] !== undefined)
        .map((k) => `    '${k}': ${table[k]},   // note`);
    return `addGate('${mirror.key}', '${unit}', {\n${lines.join('\n')}\n});\n`;
}

function indexerRoot(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-gate-activation-'));
    const dir = path.join(root, 'src', 'protocol_changes');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    return root;
}

const both = (listOver, unit) => ({ 'gates_4.js': row(LIST, listOver, unit) + row(DISP) });

describe('pre-flight drift gate: mirrored activation rows', function () {
    it('passes when every pinned table matches the indexer row', function () {
        expect(checkActivationMirrors(indexerRoot(both()))).to.equal(0);
    });

    it('passes when a row moves to a differently named part file', function () {
        expect(checkActivationMirrors(indexerRoot({ 'gates_9.js': row(LIST), 'shared_rows_7.js': row(DISP) }))).to.equal(0);
    });

    it('fails when a per-coin testnet key is armed', function () {
        expect(checkActivationMirrors(indexerRoot(both({ 'BTC:testnet': 812345 })))).to.equal(1);
    });

    it('fails when mainnet is armed from genesis', function () {
        expect(checkActivationMirrors(indexerRoot(both({ mainnet: 0 })))).to.equal(1);
    });

    it('fails when a key is added or removed', function () {
        expect(checkActivationMirrors(indexerRoot(both({ 'XYZ:testnet': 'UNARMED' })))).to.equal(1);
        expect(checkActivationMirrors(indexerRoot(both({ 'DOGE:testnet': undefined })))).to.equal(1);
    });

    it('fails when the unit changes', function () {
        expect(checkActivationMirrors(indexerRoot(both({}, 'time')))).to.equal(1);
    });

    it('fails when the protocol_changes directory is missing', function () {
        expect(checkActivationMirrors(fs.mkdtempSync(path.join(os.tmpdir(), 'drift-gate-activation-')))).to.equal(1);
    });

    it('throws when a key is absent or declared twice', function () {
        expect(() => checkActivationMirrors(indexerRoot({ 'gates_4.js': row(DISP) }))).to.throw(/exactly one/);
        expect(() => checkActivationMirrors(indexerRoot({ 'a.js': row(LIST), 'b.js': row(LIST) + row(DISP) }))).to.throw(/exactly one/);
    });

    it('throws on a value it does not understand', function () {
        expect(() => checkActivationMirrors(indexerRoot(both({ testnet: 'UNPINNED' })))).to.throw(/cannot read/);
    });
});

describe('pre-flight activation lookup', function () {
    const sdk = (network, coin) => ({ config: { network }, explorer: { coin } });

    it('resolves the network and per-coin keys with registry precedence', function () {
        expect(constants.activationThreshold('LIST_REFERENCE_VALIDITY', sdk('bitcoin-regtest'))).to.equal(0);
        expect(constants.activationThreshold('LIST_REFERENCE_VALIDITY', sdk('bitcoin-mainnet'))).to.equal('UNARMED');
        expect(constants.activationThreshold('LIST_REFERENCE_VALIDITY', sdk(undefined, 'RLTC'))).to.equal(0);
        expect(constants.activationThreshold('LIST_REFERENCE_VALIDITY', sdk('nonsense'))).to.equal(undefined);
    });
});
