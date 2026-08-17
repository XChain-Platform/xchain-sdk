#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 **********************************************************************
 *
 * Pre-flight ↔ indexer-handler drift gate (spec §8.5).
 *
 * Reads src/preflight/INDEXER-MAP.md, resolves the sibling
 * xchain-indexer checkout, and fails when any mapped handler's SHA-256
 * no longer matches the recorded hash - meaning an indexer validity
 * change landed without a paired review/update of the client check.
 *
 * SKIPS (exit 0) when no indexer checkout is present, so single-repo
 * CI stays green; the sibling CI job (which checks out both) enforces.
 *
 * Exit 0 = in sync (or skipped); exit 1 = drift.
 *
 * FAIL-SOFT INSIDE `npm run ci`. A drift exiting 1 as the first link of the
 * chain kills the run before mocha loads: no test tally, no named failing
 * test, so the shared pre-push gate cannot tell a bad commit from a bad venue.
 * The finding is still fatal to the run, just no longer fatal to the RUN'S
 * REPORTING: --soft reports and returns 0 at the head of the chain, --verdict
 * re-asserts the same evaluation as the chain's last link, after the tally
 * exists. See main().
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/* Output sink, so the gate can be run twice in one `npm run ci` without printing its
 * report twice.
 *
 * The checks below write their findings as they go, which is right for the run that a
 * reviewer reads. The closing --verdict run has the opposite need: it only re-asserts a
 * verdict already printed, so it evaluates with the sink muted and prints one line. Every
 * check writes through say()/warn() rather than console.* for that reason; a console call
 * added later would leak past the mute and duplicate the report.
 */
const CONSOLE_SINK = {
    log: (...a) => console.log(...a),
    error: (...a) => console.error(...a),
};
const MUTED_SINK = { log: () => {}, error: () => {} };
let OUT = CONSOLE_SINK;
function say(...a) { OUT.log(...a); }
function warn(...a) { OUT.error(...a); }

function resolveIndexerRoot() {
    const candidates = [
        process.env.XCHAIN_INDEXER_PATH,
        path.join(__dirname, '..', '..', 'xchain-indexer'),
    ].filter(Boolean);
    for (const root of candidates) {
        if (fs.existsSync(path.join(root, 'src', 'actions'))) return root;
    }
    return null;
}

function parseMap(mapPath) {
    const text = fs.readFileSync(mapPath, 'utf8');
    const rows = [];
    // | ... | `src/actions/x.js` | `<hash>` |
    const re = /\|\s*`(src\/actions\/[^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|/g;
    let m;
    while ((m = re.exec(text)) !== null) rows.push({ handler: m[1], hash: m[2] });
    return rows;
}

/* The indexer commit the pinned hashes were taken at.
 *
 * A hash on its own is not a usable baseline. The map tells a reviewer to "re-read the
 * changed handler", which means diffing from what was pinned to what is there now, and a
 * hash gives that diff no left-hand side. On 2026-08-13 that turned into a real trap:
 * the indexer's history was rewritten, six pinned hashes survived only as UNREACHABLE
 * BLOBS, and a reviewer following the map with a commit range would have silently
 * reviewed against the wrong baseline and re-pinned on it, which is precisely the outcome
 * this gate exists to prevent. Recovering them needed an object-store scan nobody had
 * written down.
 *
 * So the map records an anchor, and the failure path below states whether that anchor is
 * still reachable BEFORE the reviewer trusts a range built on it.
 */
function parseAnchor(mapPath) {
    const m = /Pins taken at indexer commit:\*\*\s*`([0-9a-f]{7,40})`/
        .exec(fs.readFileSync(mapPath, 'utf8'));
    return m ? m[1] : null;
}

/* Reachable means "can be the left side of a range against HEAD", which is the only
 * property the review instruction actually needs. An orphaned commit can still be present
 * in the object store, so an existence check would answer yes and hand back a range that
 * resolves to nothing useful.
 */
function anchorIsReachable(indexerRoot, anchor) {
    try {
        execFileSync('git', ['-C', indexerRoot, 'merge-base', '--is-ancestor', anchor, 'HEAD'],
            { stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

/* The fee-quote seam, which the hash rows above structurally cannot cover.
 *
 * Every mapped row is a per-handler file under src/actions/, so the row regex carries a
 * literal `src/actions/` prefix and can never match the TOP-LEVEL src/actions.js. That is the
 * file defining FEE_QUOTE_DENYLIST and FEE_QUOTE_STATIC, and until now the only thing binding
 * them to the SDK's TIER1_DENYLIST was a hand-written comment, which had already drifted.
 *
 * Compared by VALUE rather than by hash on purpose. Hashing all of actions.js would fire on
 * every unrelated edit to a large file, and anchor-scoped hashing can silently lose coverage
 * when a marker moves, which is the worse failure for financial logic. The invariant that
 * actually matters is not "actions.js is unchanged", it is that the two lists agree, so check
 * exactly that and fail closed when either literal cannot be read.
 */
function parseStringSet(text, name, where) {
    // const NAME = new Set([...]) | Object.freeze([...]) | [...]
    const re = new RegExp('const\\s+' + name + '\\s*=\\s*(?:new Set\\(|Object\\.freeze\\()?\\s*\\[([^\\]]*)\\]', 'g');
    const hits = [];
    let m;
    while ((m = re.exec(text)) !== null) hits.push(m[1]);
    if (hits.length !== 1) {
        throw new Error(`drift-gate: expected exactly one ${name} declaration in ${where}, found ${hits.length}. `
            + 'That literal is what this gate compares; find where it moved before editing this check.');
    }
    return [...new Set([...hits[0].matchAll(/['"]([A-Z_]+)['"]/g)].map((x) => x[1]))].sort();
}

/* The reverse fee-charging direction, read from indexer CALL SITES.
 *
 * On the indexer side there is no fee-charging literal to compare against: charging a
 * protocol fee IS calling createFeesObject from a handler under src/actions/. So the set is
 * derived from the handlers themselves, which makes the call sites the source of truth and
 * leaves no second list to drift. The gas-priced VM pair is the one exception: DEPLOY and
 * EXECUTE charge off GAS_SCHEDULE, never through createFeesObject, so they are named here.
 *
 * Comments and string bodies are stripped first, so a prose mention of the helper cannot
 * enrol an action. An empty walk fails CLOSED: "found no callers" must never read as "no
 * action charges a fee", the same contract parseStringSet holds.
 */
const GAS_PRICED_ACTIONS = ['DEPLOY', 'EXECUTE'];

function stripCommentsAndStrings(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');
}

function deriveFeeChargingActions(indexerRoot) {
    const dir = path.join(indexerRoot, 'src', 'actions');
    let entries;
    try {
        entries = fs.readdirSync(dir);
    } catch (e) {
        throw new Error(`drift-gate: could not read ${dir} to derive the fee-charging set `
            + `(${e && e.message ? e.message : String(e)}). Fix the read rather than skipping the check.`);
    }
    const callers = entries
        .filter((f) => f.endsWith('.js'))
        .filter((f) => /\bcreateFeesObject\s*\(/.test(stripCommentsAndStrings(fs.readFileSync(path.join(dir, f), 'utf8'))))
        .map((f) => path.basename(f, '.js').toUpperCase());
    if (callers.length === 0) {
        throw new Error('drift-gate: no handler under xchain-indexer/src/actions/ calls createFeesObject. '
            + 'That is how a protocol fee is charged, so an empty walk means this check stopped working, '
            + 'not that nothing charges a fee; fix the walk before trusting a green gate.');
    }
    return [...new Set([...callers, ...GAS_PRICED_ACTIONS])].sort();
}

function checkFeeQuoteSeam(indexerRoot) {
    const actionsPath = path.join(indexerRoot, 'src', 'actions.js');
    if (!fs.existsSync(actionsPath)) {
        warn('drift-gate: xchain-indexer/src/actions.js not found; it defines the fee-quote lists this gate pins.');
        return 1;
    }
    const indexerSrc = fs.readFileSync(actionsPath, 'utf8');
    const sdkSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preflight', 'constants.js'), 'utf8');

    const denylist = parseStringSet(indexerSrc, 'FEE_QUOTE_DENYLIST', 'xchain-indexer/src/actions.js');
    const staticSet = parseStringSet(indexerSrc, 'FEE_QUOTE_STATIC', 'xchain-indexer/src/actions.js');
    const tier1 = parseStringSet(sdkSrc, 'TIER1_DENYLIST', 'src/preflight/constants.js');
    const exempt = parseStringSet(indexerSrc, 'FEE_QUOTE_EXEMPT', 'xchain-indexer/src/actions.js');
    const feeCharging = parseStringSet(sdkSrc, 'FEE_CHARGING_ACTIONS', 'src/preflight/constants.js');

    let failed = 0;
    // FEE_CHARGING_ACTIONS drives the NATIVE_FEE_FORFEIT disclosure. Both directions
    // are bound now: this one by value against the indexer's EXEMPT literal, the other by the
    // call-site walk below, the direction the BET omission needed.
    const contradictory = feeCharging.filter((a) => exempt.includes(a));
    if (contradictory.length) {
        warn('drift-gate: FEE_CHARGING_ACTIONS claims a protocol fee for indexer-EXEMPT action(s): '
            + contradictory.join(', ') + '\n'
            + '  The NATIVE_FEE_FORFEIT warning would be shown for an action that charges nothing.');
        failed = 1;
    }
    if (denylist.join(',') !== tier1.join(',')) {
        warn('drift-gate: TIER1_DENYLIST no longer mirrors the indexer FEE_QUOTE_DENYLIST.\n'
            + `  indexer FEE_QUOTE_DENYLIST: ${denylist.join(', ')}\n`
            + `  sdk     TIER1_DENYLIST:     ${tier1.join(', ')}\n`
            + '  Tier 1 would start dry-running an action the indexer refuses to quote, or stop\n'
            + '  short-circuiting one it does. Update src/preflight/constants.js to match.');
        failed = 1;
    }
    // runTier1 returns early on TIER1_DENYLIST, which is the ONLY reason its no-verdict branch
    // cannot swallow a static valid:null quote and drop its priced fee. That
    // reachability argument holds only while STATIC stays inside the denylist.
    const escaped = staticSet.filter((a) => !tier1.includes(a));
    if (escaped.length) {
        warn('drift-gate: FEE_QUOTE_STATIC action(s) outside TIER1_DENYLIST: ' + escaped.join(', ') + '\n'
            + '  These now reach runTier1\'s endpoint call, whose no-verdict branch returns without\n'
            + '  attaching the quote, so the gas-schedule fee would be silently dropped.');
        failed = 1;
    }
    const derived = deriveFeeChargingActions(indexerRoot);
    const unlisted = derived.filter((a) => !feeCharging.includes(a));
    const orphaned = feeCharging.filter((a) => !derived.includes(a));
    if (unlisted.length || orphaned.length) {
        warn('drift-gate: FEE_CHARGING_ACTIONS no longer matches the indexer handlers that charge a fee.');
        if (unlisted.length)
            warn('  charges a protocol fee, missing from the SDK list: ' + unlisted.join(', ') + '\n'
                + '    The NATIVE_FEE_FORFEIT disclosure would be withheld for it, exactly as it was for BET.');
        if (orphaned.length)
            warn('  in the SDK list with no indexer caller: ' + orphaned.join(', ') + '\n'
                + '    Either the handler stopped charging, or it was renamed and the basename no longer\n'
                + '    matches its action name; reconcile src/preflight/constants.js against the handler.');
        failed = 1;
    }
    if (!failed) {
        say(`drift-gate: fee-quote seam in sync (denylist ${tier1.length} action(s), `
            + `${staticSet.length} static-quoted, all denylisted; ${feeCharging.length} fee-charging, `
            + 'none indexer-exempt, all matching the indexer call sites).');
    }
    return failed;
}

/* Indexer CONFIG caps this SDK mirrors as literals.
 *
 * A cap defined in xchain-indexer/src/config.js is invisible to every hash row above: the row
 * regex carries a literal src/actions/ prefix, and the handler enforcing the cap reads it by
 * symbol (this.config['MAX_REFILLS']), so the handler's hash does not move when the cap does.
 * A mapped handler hash is a proxy for the value, and this is the class of value it cannot
 * stand in for.
 *
 * Compared by VALUE for the same reason the fee-quote lists are, and fails CLOSED when either
 * literal cannot be read exactly once.
 */
const CONFIG_CAPS = [
    { name: 'MAX_REFILLS', why: 'the SDK names this cap in its DISPENSER_MAX_REFILLS unverified declaration' },
];

function parseIntLiteral(text, re, what, where) {
    const hits = [...text.matchAll(re)].map((m) => m[1]);
    if (hits.length !== 1) {
        throw new Error(`drift-gate: expected exactly one ${what} in ${where}, found ${hits.length}. `
            + 'That literal is what this gate compares; find where it moved before editing this check.');
    }
    return Number(hits[0]);
}

function checkConfigConstants(indexerRoot) {
    const configPath = path.join(indexerRoot, 'src', 'config.js');
    if (!fs.existsSync(configPath)) {
        warn('drift-gate: xchain-indexer/src/config.js not found; it defines the caps this gate pins.');
        return 1;
    }
    const configSrc = fs.readFileSync(configPath, 'utf8');
    const sdkSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preflight', 'constants.js'), 'utf8');

    let failed = 0;
    for (const { name, why } of CONFIG_CAPS) {
        const indexerValue = parseIntLiteral(configSrc,
            new RegExp("config\\[['\"]" + name + "['\"]\\]\\s*=\\s*(\\d+)", 'g'),
            `config['${name}'] assignment`, 'xchain-indexer/src/config.js');
        const sdkValue = parseIntLiteral(sdkSrc,
            new RegExp('const\\s+' + name + '\\s*=\\s*(\\d+)', 'g'),
            `const ${name} declaration`, 'src/preflight/constants.js');
        if (indexerValue !== sdkValue) {
            warn(`drift-gate: ${name} differs between xchain-indexer and this SDK:\n`
                + `  indexer src/config.js: ${indexerValue}\n`
                + `  sdk     src/preflight/constants.js: ${sdkValue}\n`
                + `  ${why}, so it would state a cap the network does not enforce.`);
            failed = 1;
        }
    }
    if (!failed)
        say(`drift-gate: indexer config cap(s) in sync (${CONFIG_CAPS.map((c) => c.name).join(', ')}).`);
    return failed;
}

/* GAS_SCHEDULE parity across the three coins.
 *
 * The SDK carries its OWN copy of each coin definition, and the gas schedule is what
 * prices every fee the pre-flight quotes. Compared as parsed key/value MAPS rather than
 * as text, so formatting and comment edits do not fire. The coin modules are pure data
 * (no requires, no env reads), so loading them here has no side effects; a module that
 * cannot be loaded, or that carries no GAS_SCHEDULE, fails CLOSED - same contract as
 * parseStringSet, because "could not read it" must never read as "it agrees".
 */
const GAS_SCHEDULE_COINS = ['BTC', 'LTC', 'DOGE'];

function loadGasSchedule(absPath) {
    const resolved = require.resolve(absPath);
    delete require.cache[resolved];
    const mod = require(resolved);
    const schedule = mod && mod.GAS_SCHEDULE;
    if (!schedule || typeof schedule !== 'object')
        throw new Error(`drift-gate: no GAS_SCHEDULE object in ${absPath}`);
    return schedule;
}

function checkGasSchedules(indexerRoot) {
    let failed = 0;
    for (const coin of GAS_SCHEDULE_COINS) {
        const indexerPath = path.join(indexerRoot, 'src', 'coins', coin + '.js');
        const sdkPath = path.join(__dirname, '..', 'src', 'coins', coin + '.js');
        let a, b;
        try {
            a = loadGasSchedule(indexerPath);
            b = loadGasSchedule(sdkPath);
        } catch (e) {
            warn((e && e.message ? e.message : String(e))
                + `\n  ${coin} gas schedules could not be compared; fix the read rather than skipping the coin.`);
            failed = 1;
            continue;
        }
        const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
        const diffs = keys.filter((k) => String(a[k]) !== String(b[k]));
        if (diffs.length) {
            warn(`drift-gate: ${coin} GAS_SCHEDULE differs between xchain-indexer and this SDK:`);
            for (const k of diffs)
                warn(`  ${k}: indexer ${a[k] === undefined ? '(absent)' : a[k]} vs sdk ${b[k] === undefined ? '(absent)' : b[k]}`);
            warn('  The pre-flight would quote a fee the indexer does not charge (or vice versa).');
            failed = 1;
        }
    }
    if (!failed)
        say(`drift-gate: GAS_SCHEDULE in sync across ${GAS_SCHEDULE_COINS.join('/')}.`);
    return failed;
}

/* Run every check and RETURN the verdict; never exit.
 *
 * Kept exit-free so the same evaluation can back three callers: the strict CLI run, the
 * fail-soft run at the head of `npm run ci`, and the muted --verdict run that closes it.
 * The gate used to be the process itself, which is why a drift killed `npm run ci` before
 * mocha loaded and the pre-push gate reported NEVER RAN instead of a named failure.
 *
 * Returns 0 for in-sync (or skipped, when there is no sibling checkout), 1 for a finding.
 */
function evaluate() {
    const mapPath = path.join(__dirname, '..', 'src', 'preflight', 'INDEXER-MAP.md');
    if (!fs.existsSync(mapPath)) {
        warn('drift-gate: INDEXER-MAP.md not found');
        return 1;
    }
    const root = resolveIndexerRoot();
    if (!root) {
        say('drift-gate: no xchain-indexer checkout; skipping (sibling CI enforces).');
        return 0;
    }

    const rows = parseMap(mapPath);
    if (rows.length === 0) {
        warn('drift-gate: no mapping rows parsed from INDEXER-MAP.md');
        return 1;
    }

    const drift = [];
    const missing = [];
    for (const { handler, hash } of rows) {
        const abs = path.join(root, handler);
        if (!fs.existsSync(abs)) { missing.push(handler); continue; }
        const actual = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
        if (actual !== hash) drift.push({ handler, expected: hash, actual });
    }

    // Report every independent check before exiting, never on the first failure: handler-hash
    // drift and a fee-quote seam break have different causes and different fixes, and exiting
    // on the first one would let unrelated stale hashes hide a live seam break behind them.
    let failed = 0;

    if (missing.length) {
        warn('drift-gate: mapped handler(s) not found in the checkout:\n  ' + missing.join('\n  '));
        failed = 1;
    }
    if (drift.length) {
        warn('drift-gate: indexer validity logic changed without a paired pre-flight review.\n' +
            'Re-read each handler, update the matching checks/ module (or confirm no client-visible\n' +
            'change), then refresh the hash in src/preflight/INDEXER-MAP.md:\n');
        for (const d of drift) warn(`  ${d.handler}\n    was ${d.expected}\n    now ${d.actual}`);
        // Now that `npm run ci` runs this locally, the first suspect for a LOCAL
        // red is the sibling's uncommitted work rather than a real handler change: this
        // hashes the WORKING TREE, and two of the four handlers in the gate's first firing
        // were nothing else. CI checks out HEAD and never sees it.
        const anchor = parseAnchor(mapPath);
        if (!anchor) {
            warn('\nThe map records no anchor commit, so there is no baseline to diff FROM.\n'
                + 'Add a "Pins taken at indexer commit" line to src/preflight/INDEXER-MAP.md.');
        } else if (anchorIsReachable(root, anchor)) {
            warn(`\nThe pins were taken at indexer commit ${anchor}, which is still reachable.\n`
                + 'Review each drifted handler with:\n'
                + `  git -C ${root} diff ${anchor}..HEAD -- <handler path above>`);
        } else {
            // The case that cost a reviewer a long detour. Say it plainly rather than
            // letting them build a range on a commit that cannot anchor one.
            warn(`\nWARNING: the anchor commit ${anchor} is NOT reachable from the indexer HEAD.\n`
                + 'That normally means the indexer history was rewritten and the pinned state was\n'
                + 'orphaned. A commit range from it is either empty or wrong, so do NOT review that\n'
                + 'way and do NOT re-pin on it. Recover the pinned content as a blob instead:\n'
                + `  git -C ${root} cat-file --batch-all-objects --batch-check='%(objecttype) %(objectname)' \\\n`
                + '    | awk \'$1=="blob"{print $2}\' \\\n'
                + '    | while read o; do [ "$(git -C <indexer> cat-file blob $o | sha256sum | cut -d" " -f1)" = "<pinned hash>" ] \\\n'
                + '        && echo "$o"; done\n'
                + 'then diff that blob against the current handler, and re-anchor the map to the new HEAD.');
        }
        warn('\nRunning locally? Confirm against COMMITTED state first - this hashes the sibling\n'
            + 'working tree, so an uncommitted edit over there reports as drift:\n'
            + '  git -C ../xchain-indexer status --short src/actions/');
        failed = 1;
    }

    // parseStringSet throws when a literal cannot be read exactly once; that is the fail-closed
    // path, so report it as a gate failure rather than an uncaught stack trace.
    try {
        if (checkFeeQuoteSeam(root)) failed = 1;
    } catch (e) {
        warn(e && e.message ? e.message : String(e));
        failed = 1;
    }
    try {
        if (checkConfigConstants(root)) failed = 1;
    } catch (e) {
        warn(e && e.message ? e.message : String(e));
        failed = 1;
    }
    try {
        if (checkGasSchedules(root)) failed = 1;
    } catch (e) {
        warn(e && e.message ? e.message : String(e));
        failed = 1;
    }

    if (failed) return 1;

    say(`drift-gate: ${rows.length} mapped handler(s) in sync.`);
    return 0;
}

/* The three run modes, and why the soft one is not a waiver.
 *
 * strict (no flag)  evaluate, print, exit 1 on a finding. What CI's own drift job and any
 *                   hand run get, and the mode the indexer-side gate runs.
 * --soft            evaluate, print the SAME report, exit 0 regardless. Used at the head of
 *                   `npm run ci` so a drift no longer kills the run before mocha loads. The
 *                   finding is not forgiven: the run ends with --verdict, which fails it.
 * --verdict         re-evaluate with the sink muted and exit 1 on a finding, printing one
 *                   line that points back at the report the soft run already printed. Used
 *                   as the LAST link of `npm run ci` so the failure lands after a tally.
 *
 * The pairing is what matters. `npm run ci` must open with --soft and close with --verdict:
 * open with strict and a drift is fatal at load again; drop the close and a drift ships
 * green. test/unit/preflight/driftGateModes.test.js asserts both halves of that wiring.
 */
function main(argv, evaluateFn) {
    const args = argv || process.argv.slice(2);
    // Injectable only so the modes can be tested against BOTH verdicts. A clean
    // evaluation cannot be synthesised from a fixture (the pins are real handler
    // bytes), and reading it off the live sibling would make the test pass or fail
    // on whatever a second coder has in that checkout today.
    const run = evaluateFn || evaluate;
    const soft = args.includes('--soft');
    const verdict = args.includes('--verdict');

    if (verdict) {
        OUT = MUTED_SINK;
        let failed;
        try {
            failed = run();
        } finally {
            OUT = CONSOLE_SINK;
        }
        if (failed) {
            warn('drift-gate: FAILED. The finding is reported in full at the top of this run '
                + '(`npm run ci:drift` re-prints it).\n'
                + '  The suites above ran and their tally stands; this gate is a separate finding, '
                + 'not a suite failure.');
        } else {
            say('drift-gate: clean.');
        }
        process.exit(failed ? 1 : 0);
    }

    const failed = run();
    if (failed && soft) {
        warn('\ndrift-gate: reported, NOT fatal here. `npm run ci` continues so the suites still\n'
            + 'produce a tally, and the gate re-asserts this finding as the last step of the run\n'
            + '(`npm run ci:drift:verdict`, exit 1). Nothing above is waived.');
        process.exit(0);
    }
    process.exit(failed ? 1 : 0);
}

if (require.main === module) main();
module.exports = {
    resolveIndexerRoot, parseMap, parseStringSet, deriveFeeChargingActions,
    checkFeeQuoteSeam, checkConfigConstants, checkGasSchedules, evaluate, main,
};
