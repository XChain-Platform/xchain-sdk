// SPDX-License-Identifier: AGPL-3.0-or-later
// Keeps the old import path src/cosigner/policyEvaluator.js working for published
// consumers that deep-import it. The module itself lives at src/cosigner/policy_evaluator.js.
module.exports = require('./policy_evaluator.js');
