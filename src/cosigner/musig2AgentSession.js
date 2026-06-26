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
 * XChain Platform SDK - MuSig2 Agent Session
 *
 * An AgentSession whose spending account is a 2-of-2 MuSig2 P2TR: the agent
 * holds one key, a policy co-signer holds the other. This is the HARD
 * enforcement that AgentSession's HONESTY NOTE points to - the co-signer
 * withholds its partial on out-of-policy actions, so the WIF holder cannot
 * bypass policy with raw SDK calls (the agent's key alone can't move funds).
 *
 *   let agent = sdk.musig2AgentSession(wif, {
 *       allowedActions: ['SEND'],
 *       maxPerAction: { SEND: { TOK: '100' } },
 *   }, {
 *       coSigner: { transport, publicKeys: [agentPub, coSignerPub] },
 *   });
 *   await agent.send({ tick: 'TOK', amount: '5', destination: addr });
 *
 * Spend path: the local AgentSession policy still runs first as a fast
 * pre-flight, then the encoder builds the PSBT against the aggregate P2TR
 * address and the co-signer is the authoritative, WIF-independent gate
 * (see musig2Signer.js + coSigner.js).
 *
 * SCOPE (P3 slice 2): key-path 2-of-2, single taproot input (see
 * musig2Signer.js). The 2-of-3 recovery tap-tree and multi-input spends are
 * later slices.
 *
 ********************************************************************/

'use strict';

const os   = require('os');
const path = require('path');
const AgentSession      = require('../agentSession.js');
const CoSignerClient    = require('./client.js');
const { deriveMuSig2P2TR, deriveMuSig2P2TR2of3 } = require('./account.js');
const { buildMuSig2Signer } = require('./musig2Signer.js');
const { SDKPolicyError } = require('../errors.js');

function pubHex(k) {
    if (Buffer.isBuffer(k) || k instanceof Uint8Array) return Buffer.from(k).toString('hex').toLowerCase();
    if (typeof k === 'string') return k.toLowerCase();
    throw new SDKPolicyError('COSIGNER_CONFIG', 'publicKeys entries must be hex strings or byte arrays');
}

class MuSig2AgentSession extends AgentSession {

    /*
     * @param sdk, wif, policy   as AgentSession (the agent's key + declarative policy)
     * @param {object} opts
     *   coSigner (or these flat on opts):
     *     transport   {function}  body -> Promise<result> (inProcessTransport / httpTransport)
     *     publicKeys  {(hex|bytes)[]}  the [agent, daemon] key-path set INCLUDING this agent's key
     *     network     {object}     bitcoinjs network for the aggregate address (optional)
     *     recovery    {hex|bytes}  optional operator-recovery pubkey. When set, the
     *                 account is a 2-of-3 tap tree {agent, daemon, recovery}: the hot
     *                 path stays agent+daemon key-path (tweaked), and either pairing
     *                 with the recovery key can spend via a script path if a party is
     *                 lost. Requires publicKeys to be exactly the [agent, daemon] pair.
     */
    constructor(sdk, wif, policy = {}, opts = {}) {
        const cfg = opts.coSigner || opts;
        const transport  = cfg.transport;
        const publicKeys = cfg.publicKeys;
        const network    = cfg.network || null;
        const recovery   = cfg.recovery || null;

        if (typeof transport !== 'function')
            throw new SDKPolicyError('COSIGNER_CONFIG',
                'MuSig2AgentSession requires a co-signer transport function (opts.coSigner.transport)');
        if (!Array.isArray(publicKeys) || publicKeys.length < 2)
            throw new SDKPolicyError('COSIGNER_CONFIG',
                'MuSig2AgentSession requires the full publicKeys signer set (>= 2)');

        // The agent's own key MUST be in the set, else its partial can never
        // aggregate to the account key. Fail closed at construction.
        const keyInfo = sdk.wallet.importWIF(wif);
        const agentHex = String(keyInfo.publicKeyHex).toLowerCase();
        const agentIdx = publicKeys.findIndex((k) => pubHex(k) === agentHex);
        if (agentIdx < 0)
            throw new SDKPolicyError('COSIGNER_KEY_MISMATCH',
                "this agent's public key is not in the MuSig2 signer set");

        // Derive the spending account + the key-path signing set/tweaks. With a
        // recovery key it is a 2-of-3 tap tree (hot path = agent+daemon key-path,
        // BIP341-tweaked); otherwise the plain 2-of-2 key-path account.
        let account, signingKeys, signingTweaks;
        if (recovery) {
            if (publicKeys.length !== 2)
                throw new SDKPolicyError('COSIGNER_CONFIG',
                    'recovery mode requires exactly the [agent, daemon] pair in publicKeys');
            const daemon = publicKeys[1 - agentIdx];
            account = deriveMuSig2P2TR2of3({ agent: publicKeys[agentIdx], daemon, recovery }, network);
            signingKeys   = account.keyPath.publicKeys;
            signingTweaks = account.keyPath.tweaks;
        } else {
            account = deriveMuSig2P2TR(publicKeys, network);
            signingKeys   = publicKeys;
            signingTweaks = account.tweaks;
        }

        // Key the client-side policy window on the AGGREGATE address (not the agent
        // p2pkh) so it tracks the account that actually spends.
        const mergedOpts = Object.assign({}, opts);
        if (!policy.stateFile && !mergedOpts.stateFile)
            mergedOpts.stateFile = path.join(os.homedir(), '.xchain', `musig2-usage-${account.address}.json`);

        super(sdk, wif, policy, mergedOpts);

        // The spending account is the aggregate/recovery P2TR; override the agent
        // p2pkh that WalletSession derived so UTXO pulls + encoder pubkey/change target it.
        this.address = account.address;
        this.musig2Account = account;

        const client = new CoSignerClient({ transport, publicKeys: signingKeys, tweaks: signingTweaks });
        this._musig2Signer = buildMuSig2Signer({ coSignerClient: client, secretKey: keyInfo.privateKey, network });
    }

    // Inject the co-signer-backed signer so LifecycleManager completes the spend via
    // MuSig2 instead of the single-WIF path. The local AgentSession policy still runs
    // first (super.submit -> _evaluate); the co-signer is the authoritative gate.
    async submit(actionData, encoderOpts = {}, submitOpts = {}) {
        return super.submit(actionData, encoderOpts,
            Object.assign({}, submitOpts, { signer: this._musig2Signer }));
    }
}

module.exports = MuSig2AgentSession;
