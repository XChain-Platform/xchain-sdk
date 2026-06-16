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
 ********************************************************************/

'use strict';

// ─── Security: untrusted action/field input + endpoint transport ──────────────
//
// Validator.validate(action, fields) is the SDK's gate between dapp-supplied
// (often user-supplied) action data and the on-chain ACTION string. Its contract
// is to RETURN an array of structured errors — never to throw — so a dapp can
// surface validation failures. _isDowngrade is the transport-security control
// that stops a malicious/compromised hub from silently moving a dapp off https.
// These attack both surfaces.

const { expect } = require('chai');
const Utility    = require('../../src/utility.js');
const Validator  = require('../../src/validator.js');
const XChainSDK  = require('../../src/XChainSDK.js');

function v() { return new Validator(new Utility()); }

describe('Security: Validator.validate — hostile actions', function () {

  const HOSTILE_ACTIONS = [
    ['empty string', ''],
    ['unknown name', 'NOTANACTION'],
    ['whitespace', '   '],
    ['SQL-injection shaped', "ISSUE'; DROP TABLE actions;--"],
    ['1 KB junk', 'X'.repeat(1024)],
    ['null byte', 'ISS\x00UE'],
    ['unicode', 'ISSUE‮'],
    ['lowercase issue', 'issue'],
  ];

  HOSTILE_ACTIONS.forEach(([label, action]) => {
    it(`returns an error array (never throws) for ${label}`, function () {
      let res;
      expect(() => { res = v().validate(action, { TICK: 'X' }); }, `validate threw on ${label}`).to.not.throw();
      expect(res).to.be.an('array');
      // An unrecognised action must be flagged, not silently accepted.
      expect(res.some(e => e.code === 'UNKNOWN_ACTION'), `${label} not flagged UNKNOWN_ACTION`).to.equal(true);
    });
  });

  it('non-string action types do not crash validation', function () {
    for (const a of [123, null, undefined, {}, [], true]) {
      let res;
      expect(() => { res = v().validate(a, {}); }, `validate threw on ${String(a)}`).to.not.throw();
      expect(res).to.be.an('array');
    }
  });

  // FIXED: validate() previously looked the action up as `formats[action]` with
  // bracket access, so any Object.prototype property name (__proto__, constructor,
  // toString, hasOwnProperty, valueOf, …) resolved up the prototype chain — the
  // truthy inherited value slipped past the UNKNOWN_ACTION guard and then threw
  // "required is not iterable" on the ACTION_REQUIRED_FIELDS lookup. The guard now
  // uses Object.prototype.hasOwnProperty.call(formats, action), so these return
  // UNKNOWN_ACTION like any other unknown action. This test pins that fix.
  it('SECURITY: prototype-chain action names return UNKNOWN_ACTION, not a crash', function () {
    for (const a of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      let res;
      expect(() => { res = v().validate(a, {}); }, `validate threw on ${a}`).to.not.throw();
      expect(res.some(e => e.code === 'UNKNOWN_ACTION'), `${a} not flagged UNKNOWN_ACTION`).to.equal(true);
    }
  });
});

describe('Security: Validator.validate — hostile field values', function () {

  // Feed a known-valid action (ISSUE) hostile values for its fields. Whatever the
  // verdict, validate() must produce an error array and never throw.
  // Restricted to the realistic untrusted domain — values that can arrive via a
  // JSON body or dapp call (object/array/string/number/boolean/null). Exotic
  // values whose own toString() throws cannot cross that boundary.
  const HOSTILE_VALUES = [
    {}, [], [1, 2], { a: { b: 1 } }, 123, true, null,
    'X'.repeat(100000), '\x00\x01\x02', '../../etc/passwd', '<script>alert(1)</script>',
    '٤٢', '-1', '1e308', 'Infinity', 'NaN',
  ];

  it('never throws across a matrix of hostile field values', function () {
    const fieldNames = ['TICK', 'AMOUNT', 'MEMO', 'DECIMALS', 'MAX_SUPPLY'];
    for (const name of fieldNames) {
      for (let i = 0; i < HOSTILE_VALUES.length; i++) {
        let res;
        expect(() => { res = v().validate('ISSUE', { [name]: HOSTILE_VALUES[i] }); },
          `validate threw on ISSUE ${name} (hostile value #${i})`).to.not.throw();
        expect(res, `non-array for ISSUE ${name} #${i}`).to.be.an('array');
      }
    }
  });

  it('a prototype-pollution-shaped field NAME does not corrupt validation', function () {
    let res;
    expect(() => { res = v().validate('ISSUE', { __proto__: 'x', TICK: 'GOOD' }); }).to.not.throw();
    expect(res).to.be.an('array');
    // The pollution attempt must not have written onto Object.prototype.
    expect({}.x).to.equal(undefined);
  });
});

describe('Security: _isDowngrade endpoint transport guard', function () {
  let sdk;
  beforeEach(function () { sdk = new XChainSDK({}); });

  it('blocks an https default being downgraded to http by hub discovery', function () {
    expect(sdk._isDowngrade('explorer', { baseUrl: 'https://explorer.xchain.io' }, 'http://evil.example')).to.equal(true);
  });

  it('allows https → https (no downgrade)', function () {
    expect(sdk._isDowngrade('explorer', { baseUrl: 'https://a' }, 'https://b')).to.equal(false);
  });

  it('leaves http/localhost dev bases unchanged (not a downgrade)', function () {
    expect(sdk._isDowngrade('explorer', { baseUrl: 'http://localhost:3000' }, 'http://localhost:4000')).to.equal(false);
  });

  it('respects the allowInsecureEndpoints opt-out', function () {
    const insecure = new XChainSDK({ allowInsecureEndpoints: true });
    expect(insecure._isDowngrade('explorer', { baseUrl: 'https://a' }, 'http://b')).to.equal(false);
  });

  it('does not throw on malformed incoming URLs (null/empty/garbage)', function () {
    for (const u of [null, undefined, '', 'not a url', 'javascript:alert(1)', '//evil']) {
      expect(() => sdk._isDowngrade('explorer', { baseUrl: 'https://a' }, u)).to.not.throw();
    }
    // A non-https garbage URL is correctly treated as insecure → blocked.
    expect(sdk._isDowngrade('explorer', { baseUrl: 'https://a' }, 'javascript:alert(1)')).to.equal(true);
  });

  // The secure-scheme check requires a strict `https://` prefix, so a scheme-less
  // host like "httpsevil.example" is NOT treated as secure and IS blocked as a
  // downgrade. (Previously `startsWith('https')` let such a value masquerade as
  // secure; impact was low since it would fail to connect downstream, but the
  // strict prefix is tighter.)
  it('SECURITY: scheme check requires https:// (not just startsWith https)', function () {
    expect(sdk._isDowngrade('explorer', { baseUrl: 'https://a' }, 'httpsevil.example')).to.equal(true);
  });
});
