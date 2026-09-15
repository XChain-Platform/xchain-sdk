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
 * XChain Platform SDK - The one logger
 *
 * Every operational line the SDK emits goes through here, so a consumer
 * (the wallet, a node, a test rig) has ONE place to redirect or silence
 * SDK output instead of patching console at the call sites it happens to
 * know about.
 *
 * The SDK is a library. Its callers already read its output through the
 * console: pm2 and systemd capture stdout/stderr, the wallet's smoke
 * suites and this repo's own unit tests replace console.warn/error/log to
 * capture or mute lines, and operators grep the plain text. So the DEFAULT
 * sink is a pass-through: the same console method, the same stream, the
 * same formatting, the arguments handed over untouched. No prefix, no
 * timestamp, no level tag, no JSON, no colour. Switching a call site from
 * console.<level>(...) to log.<level>(...) changes nothing an observer can
 * measure; test/unit/observability/logger.test.js asserts that byte for
 * byte per level.
 *
 * The console method is resolved on EVERY call, never captured at load:
 * the tests named above swap console.warn in and out around one call and
 * expect the SDK's line to land in the swap, which a reference bound at
 * require time would bypass.
 *
 * Anything richer (a structured sink, a level floor, silence) is opt-in
 * through setSink() from the embedding program. There is deliberately no
 * environment variable: an env switch would let a deploy change what a
 * library prints without any code in the consumer saying so.
 *
 ********************************************************************/

'use strict';

// Level names ARE console method names, so the default sink is a pass-through
// and not a translation table. console.trace is left out: a stack that
// passed through here would carry this module's frame and never match.
const LEVELS = Object.freeze(['log', 'info', 'warn', 'error', 'debug']);

// The active override, or null for the pass-through. One process loads one
// SDK, and a consumer that installs a sink means every SDK module.
let sink = null;

// One logger per name, so two modules asking at require time share an object.
const loggers = new Map();

// Look console[level] up at call time: a reference captured at load would
// bypass a console method the caller has swapped in.
function defaultSink(level, name, args) {
    console[level](...args);
}

// Install a sink (level, name, args) or restore the default with null;
// returns the previous sink so an override can be scoped. Nothing is
// pre-rendered, so a JSON sink and a silent sink cost the same.
function setSink(next) {
    if (next !== null && typeof next !== 'function') {
        throw new TypeError('setSink expects a function or null');
    }
    const previous = sink;
    sink = next;
    return previous;
}

// One method per level, each forwarding untouched arguments to whichever sink
// is active at call time; frozen so no level can be patched behind the sink.
function buildLogger(name) {
    const logger = { name };
    for (const level of LEVELS) {
        logger[level] = (...args) => (sink || defaultSink)(level, name, args);
    }
    return Object.freeze(logger);
}

// The logger for a module, safe at require time: the name reaches the sink
// only and the default sink never prints it. Returns a frozen
// {name, log, info, warn, error, debug}.
function getLogger(name = 'xchain-sdk') {
    const key = String(name);
    let logger = loggers.get(key);
    if (!logger) {
        logger = buildLogger(key);
        loggers.set(key, logger);
    }
    return logger;
}

module.exports = { getLogger, setSink, LEVELS };
