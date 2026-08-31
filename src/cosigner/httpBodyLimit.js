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
 * XChain Platform SDK - co-signer HTTP request-body ceiling
 *
 * ONE definition for both co-signer transports (the loopback sidecar in
 * server.js and the multi-tenant hostedServer.js). They forward the §3.9
 * envelope surface identically, so a body a request can legally carry on one
 * must be legal on the other; two hardcoded '256kb' literals is how they would
 * drift apart.
 *
 * WHY THE DEFAULT IS WHAT IT IS. The largest legal request is an envelope
 * REVEAL, which puts the payload on the wire twice, both times hex-encoded:
 * once as `envelope.script` (client.js) and once inside the PSBT hex, because
 * the reveal PSBT repeats the leaf in `tapLeafScript`. That is
 * 2 (copies) x 2 (hex) x ENVELOPE_MAX_PAYLOAD = 1,560,000 bytes before any
 * PSBT or JSON framing, so the ceiling is rounded up to 2 MiB. The previous
 * 256 KB cap sat about 6x under it, which made every envelope round with a
 * payload over roughly 85 KB unservable even though the daemon would have
 * judged it happily.
 *
 * RAISING BYTES IS NOT RAISING WORK. What bounds the daemon's CPU is
 * `maxCosignInputs` (G14, coSigner.js), and that is untouched here: the body
 * limit only ever bounded bytes. The residual cost of the raise is buffered
 * memory per in-progress upload, which is why `maxBodyBytes` is an option: an
 * exposed hosted deployment can tune the ceiling down WITHOUT going back to an
 * unnamed failure, because the 413 below fires at whatever limit is set.
 *
 ********************************************************************/

'use strict';

const { ENVELOPE_MAX_PAYLOAD } = require('../protocol/constants.js');

// Derived, never picked: see the framing argument above.
const ENVELOPE_WIRE_COPIES = 2;          // envelope.script, and the leaf inside the reveal PSBT
const HEX_EXPANSION = 2;                 // both copies travel as hex
const ENVELOPE_WIRE_BYTES = ENVELOPE_WIRE_COPIES * HEX_EXPANSION * ENVELOPE_MAX_PAYLOAD;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;   // ENVELOPE_WIRE_BYTES rounded up, leaving framing slack

// Validate an operator-supplied ceiling the way the surrounding constructors
// validate their own options: a bad value is a construction-time throw, never a
// silently substituted default.
function resolveMaxBodyBytes(value) {
    if (value === undefined || value === null) return DEFAULT_MAX_BODY_BYTES;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1)
        throw new Error('maxBodyBytes must be a positive integer number of bytes');
    return n;
}

/*
 * Express error middleware that turns body-parser's oversize error into the
 * co-signer wire shape.
 *
 * Without it the parser's error reaches Express's default handler, which
 * answers with an HTML page carrying no `reason`. `httpTransport` reads the
 * body of a non-2xx before deciding what went wrong (G13), finds nothing
 * usable, and throws COSIGNER_TRANSPORT_ERROR described as "dead sidecar, or a
 * proxy error page" - so a stated capability limit presented to the operator as
 * a network fault. Naming it here makes the client surface it as
 * SDKPolicyError('REQUEST_TOO_LARGE') with no client change at all.
 *
 * Mount AFTER the routes. Anything that is not the oversize error falls
 * through untouched, so malformed-JSON and every other parse failure keep the
 * behaviour they already had.
 *
 * The answer is reachable without a bearer token, because the body never parsed
 * and so no token was ever read. That is deliberate: it discloses only the
 * configured byte ceiling, which is cheaper than leaving every oversize request
 * looking like a dead daemon.
 */
function tooLargeHandler(maxBodyBytes, log) {
    return function onBodyTooLarge(err, req, res, next) {
        if (!err || err.type !== 'entity.too.large') return next(err);
        if (typeof log === 'function')
            log('warn', 'co-sign request rejected: body over the configured ceiling', { maxBodyBytes });
        return res.status(413).json({
            approved: false, reason: 'REQUEST_TOO_LARGE',
            detail: `request body exceeds ${maxBodyBytes} bytes; an envelope round carries the ` +
                'leaf script twice in hex, so raise maxBodyBytes or shrink the payload',
        });
    };
}

module.exports = {
    DEFAULT_MAX_BODY_BYTES,
    ENVELOPE_WIRE_BYTES,
    resolveMaxBodyBytes,
    tooLargeHandler,
};
