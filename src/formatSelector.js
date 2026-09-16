// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/formatSelector.js working for published consumers
// that deep-import it. The module itself lives at src/protocol/format_selector.js.
module.exports = require('./protocol/format_selector.js');
