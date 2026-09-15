'use strict';

// Copyright © 2025–2026 Dankest, LLC
// SPDX-License-Identifier: AGPL-3.0-or-later
const { expect } = require('chai');
const { mockSdk } = require('../../helpers/mock.js');

function reportFor(wire, explorerSpec, opts = {}) {
    const sdk = mockSdk({ explorerSpec: { getFeeQuote: () => ({ feeExempt: true }), ...explorerSpec } });
    return sdk.preflight(wire, { source: opts.source || 'me', preflight: 'report', ...opts });
}

const has = (r, code, sev) => r.findings.some(f => f.code === code && (!sev || f.severity === sev));

module.exports = { expect, has, mockSdk, reportFor };
