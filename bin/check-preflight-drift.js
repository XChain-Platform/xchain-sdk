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
 * FAILS (exit 1) when no indexer checkout resolves, naming what it looked
 * for and every place it looked. A SKIP there exits 0 having
 * compared nothing, so a dropped CI checkout step, a typo in
 * XCHAIN_INDEXER_PATH and a handler directory renamed out from under the
 * identity test would all report as a clean single-repo run. A run that has no
 * sibling ON PURPOSE (a standalone SDK clone) declares it with
 * XCHAIN_ALLOW_NO_INDEXER=1, which a reader can see; XCHAIN_REQUIRE_SIBLINGS=1
 * overrides that declaration, because a job setting both says the checkout
 * was supplied and that is the stricter claim.
 *
 * Exit 0 = in sync (or a declared standalone run); exit 1 = drift.
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
const { execFileSync } = require('child_process');
// Everything the directory shape of a handler needs: row kinds, the directory digest, the
// whole-directory fee walk and the cross-file literal reader. Kept out of this file, which
// is already over the repo's 400-line limit and may not grow.
const handlerDirs = require('./preflight_handler_dirs.js');

// Route check output through say and warn; the verdict run mutes this sink so
// evaluating twice in one CI run does not duplicate the full report.
const CONSOLE_SINK = {
    log: (...a) => console.log(...a),
    error: (...a) => console.error(...a),
};
const MUTED_SINK = { log: () => {}, error: () => {} };
let OUT = CONSOLE_SINK;
function say(...a) { OUT.log(...a); }
function warn(...a) { OUT.error(...a); }

/* Where the gate looks for the handlers, why a candidate was rejected, and the report a
 * rejection prints. In its own module because this file is already over the repo's
 * 400-line limit and may not grow; re-exported below so callers keep one import. */
const indexerRoot = require('./preflight_indexer_root.js');
const { indexerRootCandidates, describeIndexerCandidates, resolveIndexerRoot } = indexerRoot;

// Parse file, directory, and malformed map rows; handlerDirs includes every
// file in directory and split-handler shapes when hashing a pin.
function parseMap(mapPath) {
    return handlerDirs.parseMapRows(fs.readFileSync(mapPath, 'utf8'));
}

// Read the indexer commit that anchors the pinned hashes and review range.
// Reachability is checked before callers trust a range from this baseline.
function parseAnchor(mapPath) {
    const m = /Pins taken at indexer commit:\*\*\s*`([0-9a-f]{7,40})`/
        .exec(fs.readFileSync(mapPath, 'utf8'));
    return m ? m[1] : null;
}

// Require exactly one review command and the same commit in its range and the
// map anchor. This map-only check runs before any missing-sibling allowance.
function checkAnchorConsistency(mapPath) {
    const text = fs.readFileSync(mapPath, 'utf8');
    const anchor = parseAnchor(mapPath);
    if (!anchor) {
        warn('drift-gate: INDEXER-MAP.md records no "Pins taken at indexer commit" anchor, so the\n'
            + '  review instruction below it has no baseline to be checked against.');
        return 1;
    }
    const cited = [...text.matchAll(/git\s+-C\s+\S*xchain-indexer\s+diff\s+([0-9a-f]{7,40})\.\.HEAD\s+--\s+src\/actions\//g)]
        .map((m) => m[1]);
    if (cited.length !== 1) {
        warn(`drift-gate: expected exactly one "git -C ../xchain-indexer diff <anchor>..HEAD -- src/actions/" review\n`
            + `  command in INDEXER-MAP.md, found ${cited.length}. That command is what this check compares against\n`
            + '  the anchor line; find where it moved before editing this check.');
        return 1;
    }
    if (cited[0] !== anchor) {
        warn('drift-gate: INDEXER-MAP.md names two different indexer commits.\n'
            + `  anchor line ("Pins taken at indexer commit"): ${anchor}\n`
            + `  review command ("git ... diff <id>..HEAD"):     ${cited[0]}\n`
            + '  A reviewer following the command diffs from the wrong baseline and re-pins on it.\n'
            + '  The map\'s own rule: "Re-anchor this line whenever you re-pin the table, in the same edit."');
        return 1;
    }
    say(`drift-gate: map anchor and review command agree (${anchor}).`);
    return 0;
}

// Classify whether the anchor can begin a range to HEAD, distinguishing a
// shallow checkout from an orphaned commit for accurate recovery guidance.
function anchorReachability(indexerRoot, anchor, runGit = execFileSync) {
    try {
        runGit('git', ['-C', indexerRoot, 'merge-base', '--is-ancestor', anchor, 'HEAD'],
            { stdio: 'ignore' });
        return 'reachable';
    } catch (e) {
        try {
            const shallow = runGit('git', ['-C', indexerRoot, 'rev-parse', '--is-shallow-repository'],
                { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
            if (shallow === 'true') return 'shallow';
        } catch (ignored) {}
        return 'unreachable';
    }
}

// Read fee-quote lists by value because handler hash rows cannot cover the
// action-loader literals. Missing or ambiguous declarations fail closed.
function parseStringSet(text, name, where) {
    // const NAME = new Set([...]) | Object.freeze([...]) | [...]
    const re = handlerDirs.declarationPattern(name);
    const hits = [];
    let m;
    while ((m = re.exec(text)) !== null) hits.push(m[1]);
    if (hits.length !== 1) {
        throw new Error(`drift-gate: expected exactly one ${name} declaration in ${where}, found ${hits.length}. `
            + 'That literal is what this gate compares; find where it moved before editing this check.');
    }
    return [...new Set([...hits[0].matchAll(/['"]([A-Z_]+)['"]/g)].map((x) => x[1]))].sort();
}

// Derive fee-charging actions from createFeesObject call sites after stripping
// comments and strings. Gas-priced VM actions are explicit; an empty walk fails closed.
const GAS_PRICED_ACTIONS = ['DEPLOY', 'EXECUTE'];
const { stripCommentsAndStrings } = handlerDirs;

function deriveFeeChargingActions(indexerRoot) {
    const dir = path.join(indexerRoot, 'src', 'actions');
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
        throw new Error(`drift-gate: could not read ${dir} to derive the fee-charging set `
            + `(${e && e.message ? e.message : String(e)}). Fix the read rather than skipping the check.`);
    }
    // Both handler shapes, flat file and directory, with EVERY source file of a directory
    // handler; see feeWalkHandlers for why reading index.js alone is the same blind spot a
    // flat readdir of *.js once was.
    const callers = handlerDirs.feeWalkHandlers(dir, entries)
        .filter((h) => h.files.some((f) => /\bcreateFeesObject\s*\(/.test(stripCommentsAndStrings(fs.readFileSync(f, 'utf8')))))
        .map((h) => h.action.toUpperCase());
    if (callers.length === 0) {
        throw new Error('drift-gate: no handler under xchain-indexer/src/actions/ calls createFeesObject. '
            + 'That is how a protocol fee is charged, so an empty walk means this check stopped working, '
            + 'not that nothing charges a fee; fix the walk before trusting a green gate.');
    }
    return [...new Set([...callers, ...GAS_PRICED_ACTIONS])].sort();
}

// The indexer literals are read wherever the indexer declares them, not from the loader by
// path: a split moves code into parts, and a literal that moves with it must still be
// found, exactly once, so a stale copy left behind is a finding and not the value read.
function checkFeeQuoteSeam(indexerRoot) {
    const actionsPath = path.join(indexerRoot, 'src', 'actions', 'index.js');
    if (!fs.existsSync(actionsPath)) {
        warn('drift-gate: xchain-indexer/src/actions/index.js not found; it defines the fee-quote lists this gate pins.');
        return 1;
    }
    const readIndexerSet = handlerDirs.indexerLiteralReader(indexerRoot, parseStringSet);
    const sdkSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preflight', 'constants.js'), 'utf8');

    const denylist = readIndexerSet('FEE_QUOTE_DENYLIST');
    const staticSet = readIndexerSet('FEE_QUOTE_STATIC');
    const tier1 = parseStringSet(sdkSrc, 'TIER1_DENYLIST', 'src/preflight/constants.js');
    const exempt = readIndexerSet('FEE_QUOTE_EXEMPT');
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

// Compare mirrored config caps by value because handler hash rows do not move
// with symbol-based config reads. Each literal must appear exactly once.
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

// Compare mirrored regex source and flags by value because action-handler hashes
// cannot cover database rules. Each literal must appear exactly once.
const REGEX_MIRRORS = [
    {
        name: 'CANONICAL_CARET_ID',
        indexerFile: 'src/db/shared.js',
        why: 'src/preflight/universal.js decides CARET_REF_UNRESOLVABLE on this rule',
    },
];

// Parse `const NAME = /body/flags;` without treating a slash inside a
// character class as the end of the literal.
function parseRegexLiteral(text, name, where) {
    const re = new RegExp('const\\s+' + name + '\\s*=\\s*/((?:\\\\.|\\[(?:\\\\.|[^\\]\\\\])*\\]|[^/\\\\\\n])+)/([a-z]*)', 'g');
    const hits = [...text.matchAll(re)];
    if (hits.length !== 1) {
        throw new Error(`drift-gate: expected exactly one ${name} regex declaration in ${where}, found ${hits.length}. `
            + 'That literal is what this gate compares; find where it moved before editing this check.');
    }
    return { source: hits[0][1], flags: hits[0][2] };
}

function checkRegexMirrors(indexerRoot) {
    const sdkSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preflight', 'constants.js'), 'utf8');

    let failed = 0;
    for (const { name, indexerFile, why } of REGEX_MIRRORS) {
        const abs = path.join(indexerRoot, indexerFile);
        if (!fs.existsSync(abs)) {
            warn(`drift-gate: xchain-indexer/${indexerFile} not found; it declares the ${name} rule this gate pins.`);
            failed = 1;
            continue;
        }
        const indexerRule = parseRegexLiteral(fs.readFileSync(abs, 'utf8'), name, `xchain-indexer/${indexerFile}`);
        const sdkRule = parseRegexLiteral(sdkSrc, name, 'src/preflight/constants.js');
        if (indexerRule.source !== sdkRule.source || indexerRule.flags !== sdkRule.flags) {
            warn(`drift-gate: ${name} differs between xchain-indexer and this SDK:\n`
                + `  indexer ${indexerFile}: /${indexerRule.source}/${indexerRule.flags}\n`
                + `  sdk     src/preflight/constants.js: /${sdkRule.source}/${sdkRule.flags}\n`
                + `  ${why}, so the SDK would judge references against a rule the chain no longer applies.`);
            failed = 1;
        }
    }
    if (!failed)
        say(`drift-gate: mirrored indexer regex rule(s) in sync (${REGEX_MIRRORS.map((r) => r.name).join(', ')}).`);
    return failed;
}

// Compare mirrored indexer lists by value, preserving order and duplicates.
// Missing, ambiguous, or empty declarations fail closed.
const LIST_MIRRORS = [
    {
        name: 'RESERVED_FUTURE_ROOTS',
        indexerFile: 'src/consensus/reserved_roots.js',
        why: 'src/preflight/checks/issue.js refuses a new top-level ISSUE against this list',
    },
];

// Parse bare, frozen, or Set list declarations in source order, retaining
// duplicates for exact ordered comparisons.
function parseStringList(text, name, where) {
    const re = handlerDirs.declarationPattern(name);
    const hits = [];
    let m;
    while ((m = re.exec(text)) !== null) hits.push(m[1]);
    if (hits.length !== 1) {
        throw new Error(`drift-gate: expected exactly one ${name} declaration in ${where}, found ${hits.length}. `
            + 'That literal is what this gate compares; find where it moved before editing this check.');
    }
    const entries = [...hits[0].matchAll(/['"]([^'"]*)['"]/g)].map((x) => x[1]);
    if (entries.length === 0) {
        throw new Error(`drift-gate: ${name} in ${where} read as an EMPTY list. An empty reserved list would `
            + 'compare equal against another unreadable one and report a seam that is not being checked; '
            + 'fix the read rather than trusting a green gate.');
    }
    return entries;
}

function checkListMirrors(indexerRoot) {
    const sdkSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'preflight', 'constants.js'), 'utf8');

    let failed = 0;
    const summary = [];
    for (const { name, indexerFile, why } of LIST_MIRRORS) {
        const abs = path.join(indexerRoot, indexerFile);
        if (!fs.existsSync(abs)) {
            warn(`drift-gate: xchain-indexer/${indexerFile} not found; it declares the ${name} list this gate pins.`);
            failed = 1;
            continue;
        }
        const indexerList = parseStringList(fs.readFileSync(abs, 'utf8'), name, `xchain-indexer/${indexerFile}`);
        const sdkList = parseStringList(sdkSrc, name, 'src/preflight/constants.js');
        if (indexerList.join(',') !== sdkList.join(',')) {
            const onlyIndexer = indexerList.filter((x) => !sdkList.includes(x));
            const onlySdk = sdkList.filter((x) => !indexerList.includes(x));
            warn(`drift-gate: ${name} differs between xchain-indexer and this SDK:\n`
                + `  indexer ${indexerFile}: ${indexerList.length} entr(ies)\n`
                + `  sdk     src/preflight/constants.js: ${sdkList.length} entr(ies)`);
            if (onlyIndexer.length) warn(`  in the indexer only: ${onlyIndexer.join(', ')}`);
            if (onlySdk.length) warn(`  in the SDK only:     ${onlySdk.join(', ')}`);
            if (!onlyIndexer.length && !onlySdk.length)
                warn('  same members, different ORDER or a repeated entry; the two copies are pinned order-identical.');
            warn(`  ${why}, so the SDK would judge a create against a list the chain no longer applies.`);
            failed = 1;
            continue;
        }
        summary.push(`${name}: ${sdkList.length}`);
    }
    if (!failed)
        say(`drift-gate: mirrored indexer list(s) in sync (${summary.join(', ')}).`);
    return failed;
}

// Compare each ACTIVATION_MIRRORS table with its indexer addGate row by value, since no mapped hash
// covers it; fail closed unless the key appears once and every value is UNARMED or an integer.
// The literal 9999999999 reads as UNARMED, since the indexer defines UNARMED as that height (core.js).
function parseAddGateTable(body, key, where) {
    const table = {};
    const text = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) {
        const m = /^(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:\s*(UNARMED|\d+)$/.exec(part);
        if (!m) throw new Error(`drift-gate: cannot read the ${key} entry "${part}" in ${where}; `
            + 'only UNARMED or an integer literal is understood, so a new arming style must be taught here first.');
        table[m[1] || m[2] || m[3]] = (m[4] === 'UNARMED' || m[4] === '9999999999') ? 'UNARMED' : Number(m[4]);
    }
    if (!Object.keys(table).length) throw new Error(`drift-gate: ${key} in ${where} read as an EMPTY table.`);
    return table;
}

function findAddGate(dir, key) {
    const hits = [];
    const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
        const text = fs.readFileSync(path.join(dir, file), 'utf8');
        const calls = text.match(new RegExp(`addGate\\(\\s*['"]${esc}['"]`, 'g')) || [];
        const re = new RegExp(`addGate\\(\\s*['"]${esc}['"]\\s*,\\s*['"](\\w+)['"]\\s*,\\s*\\{([^}]*)\\}`, 'g');
        const parsed = [...text.matchAll(re)];
        if (parsed.length !== calls.length)
            throw new Error(`drift-gate: addGate('${key}') in ${file} is not in the (key, 'unit', { ... }) shape this gate reads.`);
        for (const m of parsed) hits.push({ file, unit: m[1], body: m[2] });
    }
    if (hits.length !== 1)
        throw new Error(`drift-gate: expected exactly one addGate('${key}') under src/protocol_changes/, found ${hits.length}.`);
    return hits[0];
}

function checkActivationMirrors(indexerRoot) {
    const { ACTIVATION_MIRRORS } = require('../src/preflight/constants.js');
    const dir = path.join(indexerRoot, 'src', 'protocol_changes');
    if (!fs.existsSync(dir)) {
        warn('drift-gate: xchain-indexer/src/protocol_changes not found; it declares the activation rows this gate pins.');
        return 1;
    }
    let failed = 0;
    for (const name of Object.keys(ACTIVATION_MIRRORS)) {
        const { key, unit, table } = ACTIVATION_MIRRORS[name];
        const hit = findAddGate(dir, key);
        const indexerTable = parseAddGateTable(hit.body, key, `xchain-indexer/src/protocol_changes/${hit.file}`);
        const keys = [...new Set(Object.keys(indexerTable).concat(Object.keys(table)))].sort();
        const differ = keys.filter((k) => indexerTable[k] !== table[k]);
        if (hit.unit !== unit || differ.length) {
            warn(`drift-gate: activation ${key} differs between xchain-indexer (${hit.file}) and ACTIVATION_MIRRORS.${name}:`);
            if (hit.unit !== unit) warn(`  unit: indexer ${hit.unit}, sdk ${unit}`);
            for (const k of differ) warn(`  ${k}: indexer ${indexerTable[k]}, sdk ${table[k]}`);
            warn('  pre-flight decides error vs unverified from this table, so the SDK would misjudge the armed network.');
            failed = 1;
        }
    }
    if (!failed) say(`drift-gate: activation row(s) in sync (${Object.keys(ACTIVATION_MIRRORS).join(', ')}).`);
    return failed;
}

// Compare each coin's gas schedule as key-value data rather than source text.
// Coin modules must load a schedule; unreadable or missing data fails closed.
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

// Run all checks and return 0 or 1 without exiting so strict, soft, and verdict
// modes share one evaluation. Missing siblings fail unless explicitly allowed.
function evaluate() {
    const mapPath = path.join(__dirname, '..', 'src', 'preflight', 'INDEXER-MAP.md');
    if (!fs.existsSync(mapPath)) {
        warn('drift-gate: INDEXER-MAP.md not found');
        return 1;
    }
    // Runs BEFORE the sibling skip on purpose: it reads only this repo's map, and the
    // single-repo mode is the one venue a documentation-only edit ever reaches.
    let failedEarly = 0;
    try {
        if (checkAnchorConsistency(mapPath)) failedEarly = 1;
    } catch (e) {
        warn(e && e.message ? e.message : String(e));
        failedEarly = 1;
    }

    const root = resolveIndexerRoot();
    if (!root) {
        // Missing indexer checkout is a finding unless standalone mode explicitly
        // declares that sibling checks are unavailable.
        if (indexerRoot.noIndexerIsDeclared()) {
            say(`drift-gate: ${indexerRoot.ALLOW_NO_INDEXER_ENV}=1 declared; skipping the sibling `
                + 'checks. Nothing in src/preflight/INDEXER-MAP.md was compared (sibling CI enforces).');
            return failedEarly;
        }
        warn(indexerRoot.unresolvedReport());
        return 1;
    }

    const rows = parseMap(mapPath);
    if (rows.length === 0) {
        warn('drift-gate: no mapping rows parsed from INDEXER-MAP.md');
        return 1;
    }

    const { missing, drift } = handlerDirs.compareRows(root, rows);

    // Report every independent check before exiting, never on the first failure: handler-hash
    // drift and a fee-quote seam break have different causes and different fixes, and exiting
    // on the first one would let unrelated stale hashes hide a live seam break behind them.
    let failed = failedEarly;

    if (missing.length) {
        warn('drift-gate: mapped handler(s) not found in the checkout, or not hashable as mapped:\n  ' + missing.join('\n  '));
        failed = 1;
    }
    if (drift.length) {
        warn('drift-gate: indexer validity logic changed without a paired pre-flight review.\n' +
            'Re-read each handler, update the matching checks/ module (or confirm no client-visible\n' +
            'change), then refresh the hash in src/preflight/INDEXER-MAP.md:\n');
        for (const d of drift) warn(handlerDirs.formatDrift(d));
        // This hashes the sibling working tree, so local uncommitted edits can
        // report drift that a clean CI checkout will not contain.
        const anchor = parseAnchor(mapPath);
        const reachability = anchor ? anchorReachability(root, anchor) : null;
        if (!anchor) {
            warn('\nThe map records no anchor commit, so there is no baseline to diff FROM.\n'
                + 'Add a "Pins taken at indexer commit" line to src/preflight/INDEXER-MAP.md.');
        } else if (reachability === 'reachable') {
            warn(`\nThe pins were taken at indexer commit ${anchor}, which is still reachable.\n`
                + 'Review each drifted handler with:\n'
                + `  git -C ${root} diff ${anchor}..HEAD -- <handler path above>`);
        } else if (reachability === 'shallow') {
            warn(`\nNOTE: the anchor commit ${anchor} cannot be checked because ${root} is a shallow clone.\n`
                + 'This does not mean the indexer history was rewritten. Re-run against a full clone,\n'
                + 'then review each drifted handler with:\n'
                + `  git -C ${root} diff ${anchor}..HEAD -- <handler path above>\n`
                + 'Do not use an object-store blob scan here because a shallow clone may not hold the pinned blobs.');
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
        if (checkRegexMirrors(root)) failed = 1;
    } catch (e) {
        warn(e && e.message ? e.message : String(e));
        failed = 1;
    }
    try {
        if (checkListMirrors(root)) failed = 1;
    } catch (e) {
        warn(e && e.message ? e.message : String(e));
        failed = 1;
    }
    try {
        if (checkActivationMirrors(root)) failed = 1;
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

// Strict mode fails immediately; soft mode prints and continues; verdict mode
// re-evaluates muted and fails after suites finish. CI must pair soft first
// with verdict last so drift remains fatal without suppressing the test tally.
function main(argv, evaluateFn) {
    const args = argv || process.argv.slice(2);
    // Inject evaluation so mode tests cover both verdicts without depending on
    // live sibling handler bytes.
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
    resolveIndexerRoot, indexerRootCandidates, parseMap, parseAnchor, parseStringSet, parseStringList, parseRegexLiteral,
    deriveFeeChargingActions, checkAnchorConsistency, anchorReachability, checkFeeQuoteSeam,
    checkConfigConstants, checkRegexMirrors, checkListMirrors, checkGasSchedules, evaluate, main,
    checkActivationMirrors, parseAddGateTable,
};
