'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// decoder.parse round-trip guarantee (spec §3.4):
//   - compose -> parse: parse(createAction(x).actionString) returns the
//     serialized field values for every golden vector (the same wire
//     contract the encoder-half golden suite pins).
//   - parse -> canonicalize is a fixpoint: parse(parse(s).actionString)
//     is byte-identical.
//   - alias table conformance vs the vendored action-manifest.
//   - one BATCH fixture per permitted action type inside COMMAND.
//
// These vectors are composed locally, so they prove the SDK agrees with
// ITSELF. The live counterpart, which proves it agrees with the CHAIN
// (real encoder PSBTs and the wire bytes the indexer recovered off
// confirmed transactions), is
// xchain-e2e-test/test/sdk/decoderRoundtrip.sdk.test.js - run it against
// a regtest venue with `npm run test:sdk:decoder`.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const config  = require('../../../src/config.js');
const Utility = require('../../../src/utility.js');
const Actions = require('../../../src/actions.js');
const formats = require('../../../src/formats.js');
const { parse, BATCH_ACTION_LIMITS } = require('../../../src/decoder/parse.js');
const { describe: describeAction } = require('../../../src/decoder/describe.js');
const { ACTION_ALIASES } = require('../../../src/decoder/aliases.js');

const GOLDEN = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'action-roundtrip-golden.json'), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'fixtures', 'action-manifest.json'), 'utf8'));

function makeActions() {
    return new Actions({ config: config.getConfig(), util: new Utility() });
}

describe('decoder round-trip guarantee', function () {

    describe('golden vectors: compose -> parse', function () {
        const actions = makeActions();
        for (const vector of GOLDEN.vectors) {
            it(`${vector.label}`, function () {
                const composed = actions.createAction({
                    action: vector.action,
                    params: { ...vector.input, version: vector.version },
                });
                const parsed = parse(composed.actionString);
                expect(parsed.ok, composed.actionString).to.equal(true);
                expect(parsed.action).to.equal(vector.action);
                expect(parsed.version).to.equal(vector.version);
                // The golden `parsed` map is the indexer's view: null for
                // absent fields, and it unions fields from OTHER versions
                // of the action (the indexer's flat param dict). Compare
                // only fields the selected version's format declares;
                // decoder.parse pads those with ''.
                const formatFieldSet = new Set(
                    formats[vector.action][vector.version].split('|')
                        .map(f => f.replace(/^\.\.\./, '')));
                for (const [field, expected] of Object.entries(vector.parsed)) {
                    if (field === 'VERSION' || !formatFieldSet.has(field)) continue;
                    const got = parsed.params[field];
                    const want = expected === null ? '' : expected;
                    if (Array.isArray(got)) expect(got, field).to.deep.equal(Array.isArray(want) ? want : [want]);
                    else expect(got, field).to.equal(String(want));
                }
                // Canonicalization reproduces the golden wire exactly.
                expect(parsed.actionString).to.equal(vector.wire);
            });
        }
    });

    describe('parse -> canonicalize fixpoint', function () {
        const wires = [
            ...GOLDEN.vectors.map(v => v.wire),
            'SEND|1|JDOG|1|a|2|b|memo',
            'SEND|2|T1|1|a|T2|2|b',
            'LIST|0|1|AAA|BBB|CCC',
            'EXECUTE|0|9|m|p1|p2',
            'DEPLOY|0|aGVsbG8=|100000|x',
            'TRANSFER|0|JDOG|1|addr',
            'VOTE|1|55|1|memo',
            'BATCH|0|MINT|0|JDOG|1;SEND|0|JDOG|1|addr',
        ];
        for (const wire of wires) {
            it(wire.length > 40 ? wire.slice(0, 40) + '…' : wire, function () {
                const p1 = parse(wire);
                expect(p1.ok, wire).to.equal(true);
                const p2 = parse(p1.actionString);
                expect(p2.ok).to.equal(true);
                expect(p2.actionString).to.equal(p1.actionString);
                expect(p2.params).to.deep.equal(p1.params);
            });
        }
    });

    describe('alias table conformance', function () {
        it('ACTION_ALIASES deep-equals the manifest aliases', function () {
            expect({ ...ACTION_ALIASES }).to.deep.equal(MANIFEST.aliases);
        });
        it('cosigner psbtActionDecode consumes the same table (single source)', function () {
            const src = fs.readFileSync(
                path.join(__dirname, '..', '..', '..', 'src', 'cosigner', 'psbtActionDecode.js'), 'utf8');
            expect(src).to.include("require('../decoder/aliases.js')");
            expect(src).to.not.match(/TRANSFER:\s*'SEND'/);
        });
    });

    describe('one BATCH fixture per permitted action type (spec §3.4)', function () {
        // Every userEncodable action that BATCH permits (respecting
        // actionLimits and excluding BATCH itself) appears once inside a
        // COMMAND blob and must parse back with its own serialization
        // intact - catching per-action drift inside the nested blob.
        const perAction = {
            SEND:      'SEND|0|JDOG|1|addr',
            MINT:      'MINT|0|JDOG|5',
            ISSUE:     'ISSUE|0|NEWTOK|1000',
            DESTROY:   'DESTROY|0|JDOG|1',
            SWEEP:     'SWEEP|0|dest',
            BROADCAST: 'BROADCAST|0|hello world',
            DIVIDEND:  'DIVIDEND|0|JDOG|GAS|1',
            AIRDROP:   'AIRDROP|0|JDOG|1|55',
            // A place-bet: the only BET format a BATCH realistically carries, and
            // the one whose OUTCOME/AMOUNT pair a nested-blob field shift would
            // scramble into a cancel.
            BET:       'BET|2|42|0|25.5',
            ORDER:     'ORDER|1|42',
            SWAP:      'SWAP|1|42',
            DISPENSER: 'DISPENSER|1|42',
            SLEEP:     'SLEEP|0|999999',
            CALLBACK:  'CALLBACK|0|JDOG',
            COLLECT:   'COLLECT|0',
            COINPAY:   'COINPAY|0|42',
            DEPOSIT:   'DEPOSIT|0|7|JDOG|1',
            WITHDRAW:  'WITHDRAW|0|7|JDOG|1',
            STAKE:     'STAKE|1|100|' + 'ab'.repeat(32),
            UNSTAKE:   'UNSTAKE|0|' + 'ab'.repeat(32),
            DELEGATE:  'DELEGATE|0|' + 'ab'.repeat(32),
            VOTE:      'VOTE|1|55|1',
            LINK:      'LINK|0|BTC|1|DOGE|2',
            ADDRESS:   'ADDRESS|0|1|0|1',
            PRICE:     'PRICE|1|BTC|JDOG|USD|1.5',
            MESSAGE:   'MESSAGE|3|BTC|addr|hi there',
            FILE:      'FILE|0|name.txt|text/plain|title',
            LIST:      'LIST|0|1|AAA',
            EXECUTE:   'EXECUTE|0|9|method|p1',
            DEPLOY:    'DEPLOY|0|aGVsbG8=|100000',
        };

        it('covers every userEncodable action except BATCH', function () {
            const encodable = Object.keys(formats).filter(a => a !== 'BATCH').sort();
            expect(Object.keys(perAction).sort()).to.deep.equal(encodable);
        });

        for (const [action, sub] of Object.entries(perAction)) {
            it(`BATCH containing ${action}`, function () {
                const wire = `BATCH|0|${sub}`;
                const r = parse(wire);
                expect(r.ok, wire).to.equal(true);
                expect(r.commands).to.have.length(1);
                const cmd = r.commands[0];
                expect(cmd.ok, JSON.stringify(cmd)).to.equal(true);
                expect(cmd.action).to.equal(action);
                // Sub-action canonicalization is stable inside the blob.
                expect(cmd.actionString).to.equal(sub);
                expect(BATCH_ACTION_LIMITS[action] === undefined ||
                       BATCH_ACTION_LIMITS[action] >= 1).to.equal(true);
            });
        }
    });

    describe('describe() coverage', function () {
        it('returns a non-empty summary for every userEncodable action', function () {
            for (const action of Object.keys(formats)) {
                const versions = Object.keys(formats[action]);
                const v = versions[0];
                const fieldCount = formats[action][v].split('|').length - 1;
                const wire = [action, v, ...Array(fieldCount).fill('1')].join('|');
                const parsed = parse(wire, { validate: false });
                expect(parsed.ok, wire).to.equal(true);
                const d = describeAction(parsed);
                expect(d.summary, action).to.be.a('string').and.to.not.equal('');
                expect(d.details).to.be.an('array');
                expect(d.warnings).to.be.an('array');
            }
        });
    });
});
