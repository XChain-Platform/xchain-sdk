'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { FEE_CHARGING_ACTIONS } = require('../../../../src/preflight/constants.js');
const { ASPECT_NOTES } = require('../../../../src/preflight/checks/misc.js');

describe('pre-flight LIST share disclosures', function () {
    it('treats LIST as fee-charging', function () {
        expect(FEE_CHARGING_ACTIONS).to.include('LIST');
    });

    it('names the owner-only whole-action SHARE and TRANSFER refusals', function () {
        expect(ASPECT_NOTES.LIST).to.match(
            /whole SHARE or TRANSFER from anyone but the list's current owner/
        );
    });
});
