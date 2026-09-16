'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { describe: describeAction } = require('../../../../src/decoder/describe.js');
const FORMATS = require('../../../../src/protocol/formats.js');

const GENERIC = /No plain-English summary is available/;

// The dedicated case list is hand-maintained, so it can only prove what
// someone remembered to add; the confirm screen is the surface a user
// verifies intent on, and an action nobody thought to list there
// silently reaches a signer as "No plain-English summary is available".
// This enumerates formats.js instead, so adding an ACTION to the
// protocol without a describer fails here rather than on a sign screen.
describe('decoder.describe', function () {
    describe('every ACTION in formats.js has a describer', function () {
        for (const action of Object.keys(FORMATS)) {
            it(action, function () {
                for (const version of Object.keys(FORMATS[action])) {
                    // Params empty on purpose: a describer must produce its
                    // summary from the action + version alone, filling gaps
                    // with "?" rather than deferring to the generic path.
                    const d = describeAction({ action, params: { VERSION: version } });
                    expect(d.warnings.join('\n'), `${action} v${version}`).to.not.match(GENERIC);
                    expect(d.summary, `${action} v${version}`).to.be.a('string').and.not.equal('');
                    expect(d.summary, `${action} v${version}`).to.not.match(/^Sign /);
                }
            });
        }
    });
});
