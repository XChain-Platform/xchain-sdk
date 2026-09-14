// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/gatedFile.js working for published consumers that
// deep-import it. The module itself lives at src/actions/gated_file.js.
module.exports = require('./actions/gated_file.js');
