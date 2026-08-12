// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// Adversarial coverage for the co-signer hardening gaps G1, G2, G3 and G5.
// The pre-existing 142 tests exercise the happy path and the DESIGNED
// denials, which is exactly why an adversarial read found these behind a
// green suite. Every case below fails against the code as it stood before
// the gap was closed.

const { expect } = require('chai');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');
const crypto  = require('crypto');
require('../../src/applyBufferutilsPatch.js');
const bitcoin = require('bitcoinjs-lib');
const { secp256k1, schnorr } = require('@noble/curves/secp256k1');
const MuSig2      = require('../../src/musig2.js');
const CoSigner    = require('../../src/cosigner/coSigner.js');
const WindowStore = require('../../src/cosigner/windowStore.js');
const { evaluatePolicy } = require('../../src/cosigner/policyEvaluator.js');
const { decodeActionFromPsbt } = require('../../src/cosigner/psbtActionDecode.js');
const { deriveMuSig2P2TR2of3 } = require('../../src/cosigner/account.js');
const valueDerivability = require('../../src/cosigner/valueDerivability.js');

function makeAccount() {
    const musig   = new MuSig2();
    const agentSk = crypto.randomBytes(32);
    const coSk    = crypto.randomBytes(32);
    const agentPk = secp256k1.getPublicKey(agentSk, true);
    const coPk    = secp256k1.getPublicKey(coSk, true);
    const keys    = [agentPk, coPk];
    const bare    = musig.aggregateKeys(keys);
    const p2tr    = bitcoin.payments.p2tr({ pubkey: Buffer.from(bare.xOnlyPubkey) });
    return { musig, agentSk, coSk, agentPk, coPk, keys, p2trScript: p2tr.output };
}

// A PSBT spending the account, carrying `actionString` in an obfuscated
// OP_RETURN built exactly as xchain-encoder builds it.
function buildSignablePsbt(acct, actionString) {
    const prevHash = crypto.randomBytes(32);
    const txid   = Buffer.from(prevHash).reverse().toString('hex');
    const inner  = bitcoin.script.compile([Buffer.from(actionString, 'utf8')]);
    const tagged = Buffer.concat([Buffer.from('XCHN'), inner]);
    const cipher = crypto.createCipheriv('aes-128-ctr', txid.substr(0, 16), txid.substr(16, 16));
    const obf    = Buffer.concat([cipher.update(tagged), cipher.final()]);

    const psbt = new bitcoin.Psbt();
    psbt.addInput({ hash: prevHash, index: 0, witnessUtxo: { script: acct.p2trScript, value: 100000 } });
    psbt.addOutput({ script: bitcoin.payments.embed({ data: [obf] }).output, value: 0 });
    psbt.addOutput({ script: acct.p2trScript, value: 90000 });
    return psbt;
}

// A live agent nonce, so an APPROVED path actually reaches the signing step.
function agentNonce(acct) {
    return new MuSig2().generateNonce({ publicKey: acct.agentPk, secretKey: acct.agentSk });
}

function tmpStateFile(tag) {
    return path.join(os.tmpdir(), `cosigner-${tag}-${crypto.randomBytes(6).toString('hex')}.json`);
}

// G1: an attacker-chosen TICK must not poison the daemon.

describe('G1: decoded params are untrusted input', function () {

    it('a tick colliding with an Object.prototype member does not wedge the daemon forever', function () {
        // 'constructor' is a PERFECTLY LEGAL tick under the protocol charset
        // (pure alphanumerics), so charset validation cannot be what saves us
        // here - the null-prototype window map is. Before the fix: the first
        // request was approved and persisted, and every request after it died in
        // snapshot() feeding Object.prototype.constructor into decimal addition.
        // On a plain 2-of-2 that is a permanent, remotely-triggered freeze.
        const acct      = makeAccount();
        const stateFile = tmpStateFile('poison');
        const store     = new WindowStore(stateFile, 24, null, { init: true });
        try {
            const co = new CoSigner({
                secretKey:   acct.coSk,
                publicKeys:  acct.keys,
                windowStore: store,
                // No per-tick cap for SEND, so the poisoned key is never consulted
                // during evaluation and the action is approved on its way in.
                policy: { allowedActions: new Set(['SEND']),
                          maxPerWindow: { hours: 24, maxActions: 10 } },
            });

            const first = co.process({
                psbt: buildSignablePsbt(acct, 'SEND|0|constructor|5|1destX|m').toHex(),
                inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
            });
            expect(first.approved).to.equal(true);

            // The poisoned entry is now persisted. A second, entirely ordinary
            // request must still be decidable.
            const second = co.process({
                psbt: buildSignablePsbt(acct, 'SEND|0|MYTOKEN|5|1destX|m').toHex(),
                inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
            });
            expect(second.approved).to.equal(true);

            // And the poisoned tick accumulated as an ordinary string key.
            expect(store.snapshot().perTick.constructor).to.equal('5');
            expect(store.quarantined()).to.have.length(0);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('refuses a tick the protocol could never mint (DECODE_PARAM_INVALID)', function () {
        const acct = makeAccount();
        const co   = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SEND']) } });

        // Backslash is outside the canonical TICK charset, so no real token can
        // carry this name and it has no business reaching a policy lookup.
        const res = co.process({
            psbt: buildSignablePsbt(acct, 'SEND|0|BAD\\TICK|5|1destX|m').toHex(),
            inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
        });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('DECODE_PARAM_INVALID');
    });

    it('accepts the compact ^<id> tick reference, which is legal wire form', function () {
        const psbt = buildSignablePsbt(makeAccount(), 'SEND|0|^4321|5|1destX|m');
        const decoded = decodeActionFromPsbt(psbt);
        expect(decoded.ok).to.equal(true);
        expect(decoded.params.TICK).to.equal('^4321');
    });

    it('a cap lookup never resolves to an inherited prototype member', function () {
        // policy.maxPerAction.SEND is a plain object; a tick of 'constructor'
        // must read as "no per-tick cap configured" and fall through to '*',
        // not as Object.prototype.constructor (truthy, and fatal in gtDecimal).
        const verdict = evaluatePolicy(
            { allowedActions: ['SEND'], maxPerAction: { SEND: { '*': '10' } } },
            { action: 'SEND', version: 0, params: { TICK: 'constructor', AMOUNT: '50' } },
        );
        expect(verdict.ok).to.equal(false);
        expect(verdict.violation.code).to.equal('POLICY_AMOUNT_EXCEEDED');
        expect(verdict.violation.details.cap).to.equal('10');
    });

    it('an unaccumulable legacy entry now fails the LOAD closed, not just quarantine', function () {
        // Superseded contract: this used to assert the store kept serving and merely
        // quarantined the row. Quarantining keeps it in `count` but drops its amount
        // from perTick, which LOOSENS the per-tick cap policyEvaluator enforces - the
        // one direction this file must never fail in. Refuse the file instead.
        const stateFile = tmpStateFile('legacy');
        fs.writeFileSync(stateFile, JSON.stringify({ entries: [
            { t: Date.now(), action: 'SEND', tick: 'TOK', amount: 'not-a-number' },
            { t: Date.now(), action: 'SEND', tick: 'TOK', amount: '7' },
        ] }));
        let store, err;
        try {
            store = new WindowStore(stateFile, 24, null, { onFault: () => {} });
        } catch (e) { err = e; }
        try {
            expect(err, 'the poisoned row must be refused').to.exist;
            expect(err.code).to.equal('WINDOW_STATE_CORRUPT');
            expect(err.message).to.match(/entry 0 has an unaddable amount/);
        } finally {
            if (store) store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(stateFile + '.lock'); } catch (e) { /* ignore */ }
        }
    });

    it('a row with a non-finite timestamp is refused (it would be pruned away silently)', function () {
        // _pruned filters on `e.t >= cutoff`; undefined >= n is false, so the row
        // vanishes from both count and perTick, handing back spent budget.
        const stateFile = tmpStateFile('nofinite-t');
        fs.writeFileSync(stateFile, JSON.stringify({ entries: [
            { t: Date.now(), action: 'SEND', tick: 'TOK', amount: '7' },
            { action: 'SEND', tick: 'TOK', amount: '7' },
        ] }));
        let store, err;
        try {
            store = new WindowStore(stateFile, 24, null, { onFault: () => {} });
        } catch (e) { err = e; }
        try {
            expect(err).to.exist;
            expect(err.code).to.equal('WINDOW_STATE_CORRUPT');
            expect(err.message).to.match(/entry 1 has a non-finite timestamp/);
        } finally {
            if (store) store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
            try { fs.unlinkSync(stateFile + '.lock'); } catch (e) { /* ignore */ }
        }
    });

    it('a count-only row (no amount) is legitimate and still loads', function () {
        const stateFile = tmpStateFile('countonly');
        fs.writeFileSync(stateFile, JSON.stringify({ entries: [
            { t: Date.now(), action: 'SEND' },
            { t: Date.now(), action: 'SEND', tick: 'TOK', amount: '7' },
        ] }));
        const store = new WindowStore(stateFile, 24, null, { onFault: () => {} });
        try {
            const snap = store.snapshot();
            expect(snap.count).to.equal(2);
            expect(snap.perTick.TOK).to.equal('7');
            expect(store.quarantined()).to.have.length(0);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('a future-dated finite timestamp is still CLAMPED, never rejected', function () {
        // The clock guard deliberately keeps such a row (dropping it would loosen the
        // budget); the new row guard must not turn that clamp into a refusal.
        const stateFile = tmpStateFile('future-t');
        const future = Date.now() + 86400000;
        fs.writeFileSync(stateFile, JSON.stringify({ entries: [
            { t: future, action: 'SEND', tick: 'TOK', amount: '7' },
        ] }));
        const faults = [];
        const store = new WindowStore(stateFile, 24, null, { onFault: (m) => faults.push(m) });
        try {
            const snap = store.snapshot();
            expect(snap.count).to.equal(1);
            expect(snap.perTick.TOK).to.equal('7');
            expect(faults.join(' ')).to.match(/clamped/);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });
});

// G2: amount caps must not silently no-op.

describe('G2: value-derivability allowlist', function () {

    const capPolicy = (actions) => ({
        allowedActions: new Set(actions),
        maxPerAction:   { SEND: { '*': '100' } },     // any amount-limiting intent
    });

    it('denies an index-reference action under an amount cap', function () {
        // SWAP v1 cancels a swap named only by ACTION_INDEX: the value moved is a
        // property of that on-chain object, which the daemon cannot read. Before
        // the fix its amount resolved to undefined and EVERY amount gate skipped,
        // so it was approved with no enforcement and no error.
        const acct = makeAccount();
        const co   = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: capPolicy(['SEND', 'SWAP']) });
        const res  = co.process({
            psbt: buildSignablePsbt(acct, 'SWAP|1|991234|m').toHex(),
            inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
        });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('POLICY_UNBOUNDED_ACTION');
    });

    it('allows the same action when the policy expresses no amount intent', function () {
        // The gate fires on the operator's amount-limiting INTENT, not on the
        // action: a count-only policy is not lied to by an unbounded action.
        const acct = makeAccount();
        const co   = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['SWAP']) } });
        const res  = co.process({
            psbt: buildSignablePsbt(acct, 'SWAP|1|991234|m').toHex(),
            inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
        });
        expect(res.approved).to.equal(true);
    });

    it('denies an ownership ORDER, whose escrow no amount cap can express', function () {
        // ORDER v0 is derivable in its ordinary shape (GIVE_TICK + GIVE_AMOUNT),
        // but GIVE_OWNERSHIP escrows the TOKEN'S OWNERSHIP instead - value with no
        // amount at all. The per-format entry is demoted per-request rather than
        // the whole format being refused.
        const acct = makeAccount();
        const co   = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: capPolicy(['SEND', 'ORDER']) });
        // ORDER v0: GIVE_COIN|GIVE_TICK|GIVE_AMOUNT|GIVE_OWNERSHIP|GET_COIN|GET_TICK|
        //           GET_AMOUNT|GET_OWNERSHIP|GET_ADDRESS|EXPIRATION|ALLOW_LIST|BLOCK_LIST|MEMO
        const order = (giveAmount, giveOwnership) => 'ORDER|0|' + [
            'BTC', 'MYTOKEN', giveAmount, giveOwnership,
            'BTC', 'OTHER', '5', '', '1destX', '100', '', '', 'm',
        ].join('|');

        const owned = co.process({
            psbt: buildSignablePsbt(acct, order('', '1')).toHex(),
            inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
        });
        expect(owned.approved).to.equal(false);
        expect(owned.reason).to.equal('POLICY_UNBOUNDED_ACTION');

        const plain = co.process({
            psbt: buildSignablePsbt(acct, order('5', '')).toHex(),
            inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
        });
        expect(plain.approved).to.equal(true);
    });

    it('denies an ISSUE that hands the token ownership away', function () {
        const acct = makeAccount();
        const co   = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            policy: capPolicy(['SEND', 'ISSUE']) });
        // ISSUE v1: TICK|DESCRIPTION|MEMO is a pure description edit -> allowed.
        expect(co.process({
            psbt: buildSignablePsbt(acct, 'ISSUE|1|MYTOKEN|a new description|m').toHex(),
            inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
        }).approved).to.equal(true);

        // ISSUE v0 with TRANSFER set hands the whole token to another address.
        const fields = new Array(23).fill('');
        fields[0] = 'MYTOKEN';                 // TICK
        fields[6] = '1attackerAddr';           // TRANSFER
        const res = co.process({
            psbt: buildSignablePsbt(acct, `ISSUE|0|${fields.join('|')}`).toHex(),
            inputs: [{ index: 0, agentPublicNonce: agentNonce(acct) }],
        });
        expect(res.approved).to.equal(false);
        expect(res.reason).to.equal('POLICY_UNBOUNDED_ACTION');
    });

    it('rejects a policy whose amount cap could never bind, at construction', function () {
        // Every decodable COINPAY format defines its value by reference, so a
        // maxPerAction.COINPAY entry is decorative. An operator who writes one
        // believes an amount ceiling is enforced; say so instead of accepting it.
        const acct = makeAccount();
        expect(() => new CoSigner({
            secretKey: acct.coSk, publicKeys: acct.keys,
            policy: { allowedActions: new Set(['COINPAY']), maxPerAction: { COINPAY: { '*': '10' } } },
        })).to.throw(/can never bind/);
    });

    it('binds VOTE escrow to the gas tick, not to the governance tick it names', function () {
        // VOTE v0's TICK names the GOVERNANCE token (the electorate), while
        // DEPOSIT and GAS_ESCROW are both denominated in gas. Binding the cap to
        // the decoded TICK charged the wrong token's budget entirely: the gas
        // ceiling never bound, and the governance token's window was consumed by
        // spending that never touched it.
        const verdict = evaluatePolicy(
            { allowedActions: ['VOTE'] },
            { action: 'VOTE', version: 0, params: { TICK: 'GOVTOKEN', DEPOSIT: '5', GAS_ESCROW: '1' } },
        );
        expect(verdict.ok).to.equal(true);
        expect(verdict.evaluation.tick).to.equal('XCHAIN');
        expect(verdict.evaluation.amount).to.equal('6');
    });

    it('conformance: every decoder-reachable format is classified', function () {
        // The CI tripwire: adding a format to formats.js without deciding whether
        // an amount cap can bind it must fail here, not silently become another
        // uncapped action in production.
        const unclassified = valueDerivability.decodableFormats().filter(({ action, version }) => {
            const byAction = valueDerivability.TABLE[action];
            return !byAction || byAction[String(version)] === undefined;
        });
        expect(unclassified.map((f) => `${f.action} v${f.version}`)).to.deep.equal([]);
    });

    it('conformance: no format is classified that the decoder cannot reach', function () {
        // The other direction: a stale entry for a format the decoder refuses is
        // dead weight that misleads the next reader about the enforced surface.
        const reachable = new Set(valueDerivability.decodableFormats().map((f) => `${f.action} v${f.version}`));
        const stale = [];
        for (const action of Object.keys(valueDerivability.TABLE))
            for (const version of Object.keys(valueDerivability.TABLE[action]))
                if (!reachable.has(`${action} v${version}`)) stale.push(`${action} v${version}`);
        expect(stale).to.deep.equal([]);
    });
});

// G3: a supplied taproot tweak is an unverifiable commitment.

describe('G3: tap-tree provenance', function () {

    // The attack this closes: a compromised agent controlling provisioning hands
    // the daemon a tweak computed over a tree that contains `<agentPubkey>
    // OP_CHECKSIG`. The daemon derives exactly the funded address, every gate
    // passes, and the agent can then spend the entire account alone through that
    // leaf - no daemon, no policy, no window, and on-chain indistinguishable
    // from a cooperative spend.
    function poisonedTree(agentPk, daemonPk) {
        const internal   = Buffer.from(new MuSig2().aggregateKeys([agentPk, daemonPk]).xOnlyPubkey);
        const agentXOnly = Buffer.from(agentPk).subarray(1);          // drop the parity byte
        const agentLeaf  = bitcoin.script.compile([agentXOnly, bitcoin.opcodes.OP_CHECKSIG]);
        const p2tr       = bitcoin.payments.p2tr({ internalPubkey: internal, scriptTree: { output: agentLeaf } });
        const tweak      = bitcoin.crypto.taggedHash('TapTweak', Buffer.concat([internal, p2tr.hash]));
        return { internal, agentLeaf, agentXOnly, output: p2tr.output, tweak };
    }

    it('the poisoned tree really does grant the agent a unilateral spend', function () {
        // Establishes that the refusal below is protecting against a live hazard
        // rather than a theoretical one: a single agent signature satisfies the
        // leaf, with no daemon participation of any kind.
        const acct   = makeAccount();
        const tree   = poisonedTree(acct.agentPk, acct.coPk);
        const leafHash = bitcoin.crypto.taggedHash('TapLeaf',
            Buffer.concat([Buffer.from([0xc0]), bitcoin.script.compile([tree.agentLeaf]).subarray(0, 0),
                           Buffer.from([tree.agentLeaf.length]), tree.agentLeaf]));
        const sig = schnorr.sign(leafHash, acct.agentSk);
        expect(schnorr.verify(sig, leafHash, tree.agentXOnly)).to.equal(true);
    });

    it('refuses a supplied tweak outright', function () {
        const acct = makeAccount();
        const tree = poisonedTree(acct.agentPk, acct.coPk);
        expect(() => new CoSigner({
            secretKey: acct.coSk, publicKeys: acct.keys,
            tweaks: [{ tweak: tree.tweak, xOnly: true }],
            policy: { allowedActions: new Set(['SEND']) },
        })).to.throw(/not accepted/);
    });

    it('derives the 2-of-3 tree itself, and lands somewhere the agent did not choose', function () {
        const acct       = makeAccount();
        const recoverySk = crypto.randomBytes(32);
        const recoveryPk = Buffer.from(secp256k1.getPublicKey(recoverySk, true));

        const co = new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            recoveryPublicKey: recoveryPk, policy: { allowedActions: new Set(['SEND']) } });

        const canonical = deriveMuSig2P2TR2of3({
            agent: acct.agentPk, daemon: acct.coPk, recovery: recoveryPk,
        });
        expect(co.accountScript.equals(canonical.output)).to.equal(true);

        // The whole point: the agent's chosen tree is NOT what the daemon guards.
        const poisoned = poisonedTree(acct.agentPk, acct.coPk);
        expect(co.accountScript.equals(poisoned.output)).to.equal(false);
    });

    it('an empty tweaks array is still accepted (it is the 2-of-2 no-tweak case)', function () {
        const acct = makeAccount();
        expect(() => new CoSigner({ secretKey: acct.coSk, publicKeys: acct.keys,
            tweaks: [], policy: { allowedActions: new Set(['SEND']) } })).to.not.throw();
    });
});

// G5: single writer is a safety property.

describe('G5: window-store single-writer lock', function () {

    it('refuses a second store on the same state file', function () {
        // Two daemons sharing one store do not merely race a counter: each caches
        // the entry array in memory and rewrites the WHOLE file from that cache,
        // so they alternately discard each other's entire consumption history and
        // silently re-open the full budget.
        const stateFile = tmpStateFile('lock');
        const first = new WindowStore(stateFile, 24, null, { init: true });
        try {
            let err = null;
            try { new WindowStore(stateFile, 24, null, { init: true }); } catch (e) { err = e; }
            expect(err).to.not.equal(null);
            expect(err.code).to.equal('WINDOW_STORE_LOCKED');
            expect(err.holderPid).to.equal(process.pid);
        } finally {
            first.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('a released lock can be taken by the next store', function () {
        const stateFile = tmpStateFile('lock-release');
        const first = new WindowStore(stateFile, 24, null, { init: true });
        first.record({ action: 'SEND', tick: 'TOK', amount: '5' });
        first.release();
        const second = new WindowStore(stateFile, 24, null, { init: true });
        try {
            expect(second.snapshot().perTick.TOK).to.equal('5');
        } finally {
            second.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });

    it('takes over a lock whose holder is dead, so a crash is not operator-only recovery', function () {
        const stateFile = tmpStateFile('lock-stale');
        // pid 2^22 is above the default pid_max on Linux and macOS, so it is
        // reliably not a live process.
        fs.writeFileSync(stateFile + '.lock', JSON.stringify({ pid: 4194304, t: Date.now() }));
        const store = new WindowStore(stateFile, 24, null, { init: true });
        try {
            expect(store.snapshot().count).to.equal(0);
        } finally {
            store.release();
            try { fs.unlinkSync(stateFile); } catch (e) { /* ignore */ }
        }
    });
});
