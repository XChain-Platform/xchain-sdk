'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const { describe: describeAction } = require('../../../../src/decoder/describe.js');

// A label ending in "to" names a destination, even when it carries an amount word

describe('describe: an address row is not amount-checked', function () {

    const OWNER = 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh';

    function issueWithTransferSupply() {
        return describeAction({
            action: 'ISSUE',
            params: { VERSION: '2', TICK: 'MYTOKEN', MINT_SUPPLY: '1000', TRANSFER_SUPPLY: OWNER }
        });
    }

    // "Transfer minted supply to" holds TRANSFER_SUPPLY, which is an address, but
    // the label matches the amount heuristic on the word "supply". Running it
    // through formatAmount flagged every legitimate owner issue-and-transfer as
    // junk on the confirm screen the wallet shows before signing.
    it('does not flag a valid address as a malformed decimal', function () {
        const d = issueWithTransferSupply();
        expect(d.warnings.join('\n')).to.not.match(/not a plain decimal/);
        expect(d.details.find(x => x.label === 'Transfer minted supply to').value).to.equal(OWNER);
    });

    // The same label must still be recognised as a destination, so the
    // your-address and contact annotations reach it.
    it('still annotates it as a destination the signer owns', function () {
        const d = describeAction(
            { action: 'ISSUE', params: { VERSION: '2', TICK: 'MYTOKEN', MINT_SUPPLY: '1000', TRANSFER_SUPPLY: OWNER } },
            { ownAddresses: [OWNER] }
        );
        expect(d.details.find(x => x.label === 'Transfer minted supply to').value).to.include('(your address)');
    });
});
