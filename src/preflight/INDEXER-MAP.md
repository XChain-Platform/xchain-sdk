# Pre-flight ↔ indexer-handler drift map

The Tier-2 client checks in `checks/` mirror validity logic that lives
authoritatively in `xchain-indexer/src/actions/*.js`. When an indexer
handler's validity logic changes, the corresponding client check can
silently drift out of ground-truth, so the drift gate
(`bin/check-preflight-drift.js`, run by `npm run ci` here and by the CI
job on both repos) fails when any mapped indexer handler's SHA-256
changes without a matching update here.

To resolve a drift-gate failure: re-read the changed handler, update the
client check (or confirm no client-visible logic changed), then refresh
the hash below and re-run `node bin/check-preflight-drift.js`.

A drift no longer kills `npm run ci` before the suites load. The chain
opens with `ci:drift:soft`, which prints the whole finding and returns 0,
and closes with `ci:drift:verdict`, which re-asserts it and exits 1 after
a test tally exists. A finding is therefore still fatal to the run, and
is now reported as a named failure rather than as a dead run: it used to
exit before mocha started, and the shared pre-push gate reads "no tally,
no named failure" as THE SUITE NEVER RAN, so three drifts in three weeks
each blocked every push from this repo behind a banner that could not
tell a bad commit from a bad venue. The bare
`node bin/check-preflight-drift.js` is unchanged and still exits 1; that
is what the CI drift jobs on both repos run.

Ground-truthed against HEAD 2026-07-20; `dispenser.js` and `dispense.js`
re-reviewed against HEAD 2026-07-26, nine handlers re-reviewed against
HEAD 2026-08-08, ALL ELEVEN re-reviewed against indexer HEAD
`22f0f31` on 2026-08-13, and NINE re-reviewed against indexer HEAD
`58ab8e9` on 2026-08-15 (see the review log below). Hashes
are of the indexer handler source files, resolved via
`XCHAIN_INDEXER_PATH` or the sibling `../xchain-indexer` checkout. The
gate SKIPS (does not fail) when no indexer checkout is present, so
single-repo CI stays green; the sibling CI job enforces it.

Note when running this locally: the gate hashes the sibling WORKING TREE,
so an uncommitted edit in `xchain-indexer` reports as drift. CI checks out
HEAD, so CI sees only committed change. Hashes recorded here are always
HEAD hashes.

**Pins taken at indexer commit:** `a1d36eb`

(Re-anchored 2026-08-15: the pins were reviewed against `58ab8e9`, a local
commit the LIST-memo rebase orphaned before push. Every pinned hash is
byte-identical at `a1d36eb`, the pushed develop head, so the review stands
and only the anchor moves.)

That anchor is the left-hand side of the review. To see what a drifted
handler actually did since it was pinned:

    git -C ../xchain-indexer diff 22f0f31..HEAD -- src/actions/<handler>.js

Re-anchor this line whenever you re-pin the table, in the same edit.

### When the anchor is not reachable

A hash is not a baseline on its own, and this bit the review on 2026-08-13.
The indexer's history was rewritten by the published-history scrub, and SIX
of the eleven pinned hashes survived only as **unreachable blobs**: the
content still existed in the object store, but no commit reached it. A
reviewer following the instruction above would have got an empty or
misleading range, reviewed against the wrong baseline, and re-pinned on it,
which defeats the whole gate. The drift gate now checks the anchor's
reachability and says so before you build a range on it.

If the anchor is gone, recover the pinned CONTENT as a blob rather than
guessing a commit. Find the object whose SHA-256 matches the pinned hash:

    git -C ../xchain-indexer cat-file --batch-all-objects \
      --batch-check='%(objecttype) %(objectname)' | awk '$1=="blob"{print $2}' \
      | while read o; do \
          [ "$(git -C ../xchain-indexer cat-file blob $o | sha256sum | cut -d' ' -f1)" \
            = "<pinned hash>" ] && echo "$o"; \
        done

Then `git -C ../xchain-indexer cat-file blob <object>` is the exact file
that was reviewed, and diffing it against the current handler is the real
review. Re-anchor to the new HEAD once you re-pin.

Note the two hashes are different things and mixing them up wastes an hour:
the table pins a **SHA-256 of file content**, while git object names are
SHA-1, so the pinned hash never appears as an object name and can only be
found by hashing candidate blobs as above.

| Client check module | Indexer handler | SHA-256 |
|---|---|---|
| `checks/send.js` (SEND) | `src/actions/send.js` | `a7c07ad1505dba1eb06efd62cfbe7f8dc6fa8654a5a6825d2ed6480190d4fbdb` |
| `checks/send.js` (DESTROY) | `src/actions/destroy.js` | `15e134f5c27b5955e27e78187848e1878cee562a52b173dacf89389f5949aa98` |
| `checks/mint.js` | `src/actions/mint.js` | `e491154c399be3fdd5b6b242b3da24db6c5119d4683988308b8087e4dc8dff03` |
| `checks/issue.js` | `src/actions/issue.js` | `9287f93d10c013ae4b66cae07005b498019c653c6b11406d37cb603f16cae561` |
| `checks/dispenser.js` (open/edit/close) | `src/actions/dispenser.js` | `3636c269cd7f989469c15a4443df58185ec17f7fc72d7b799686bd554da506bc` |
| `checks/dispenser.js` (DISPENSE) | `src/actions/dispense.js` | `97d2432f1c5eeab86648dc9bc6caa3c8b062bdc8e35851473c4c067569b53050` |
| `checks/trading.js` (ORDER) | `src/actions/order.js` | `e9c676ff4d724b92bd94966bf6811d23bc932ed34daa694211833302e53b6b02` |
| `checks/trading.js` (SWAP) | `src/actions/swap.js` | `971338842f897e140d27565a4e01cdb364da14b81bb58e140dd6014d529b35fb` |
| `checks/airdrop.js` | `src/actions/airdrop.js` | `956463e64bb90087364b2c109c6d1f27a5b3526fd24415d6b9c22042e65e1479` |
| `checks/dividend.js` | `src/actions/dividend.js` | `4755e314c69ead436a278a6d6196df5499a44768a236a2d9afda4b6a8623f1c1` |
| `checks/batch.js` | `src/actions/batch.js` | `6d5001d89dfd7fabca44a95f69b38a84a684b7f6b4e72c022b7d1f039be074a2` |

Actions covered by `checks/misc.js` (unverified-only, no client validity
logic) are intentionally NOT mapped: there is nothing to drift from.

## Review log

A hash refresh is only honest if someone actually read the diff. What was
read, and what it changed on the client side, goes here.

### 2026-08-16 - the BUILDER's weight posture is REVERSED (XC-1542)

No handler moved. What moved is this file's own 2026-08-15 (fifth pass)
answer, and it is recorded here rather than edited out of that entry so the
reversal is visible where the reasoning lives.

That entry answered the posture question with "WARNING, not refusal" for BOTH
compose-side sites. **For `batchBuilder.js` that answer is now overturned: the
builder REFUSES an over-budget batch**, in the arbiter's own position (after
the count pre-filter, before the per-ACTION cap loop), with the arbiter's own
arithmetic. The reason the earlier answer gave is real but it does not decide
this site:

- The false-block risk it names applies to a batch composed FOR mainnet while
  `BATCH_COST_WEIGHTING` is unarmed there. It is the same risk the 250-command
  cap beside it carried under `BATCH_ISSUANCE_LIMITS`, and this builder has
  always refused on that one, because a composer can shrink a batch while a
  chain rejection costs a broadcast.
- The two DECODE-side sites keep the warning, and that split is the point
  rather than an inconsistency: they describe a batch someone else already
  composed and can only report, while the builder is the one site that can
  still fix the shape before it is signed.

`validator.js` is UNCHANGED and still carries no weight rule at all: it
validates a finished BATCH command string, which is the decode side of the
split above. The weight arithmetic itself lives once, in
`batchLimits.js` (`actionWeight`, which `subCommandWeight` now calls), so the
compose and decode sites cannot come to weigh an action two ways. Pinned by
`test/unit/batchBuilderCostWeight.test.js`, whose arbiter half drives the same
vectors through the real `xchain-indexer` Batch handler.

### 2026-08-15 - nine handlers, `9d15127..58ab8e9`

Eight of the nine are the SAME one-line edit and change no validity logic
at all: the amount interpolated into each handler's `console.log` status
line is now wrapped in `util.logAmount()`. Amounts render exponentially
below 1e-7 once `setNumberFormats` has replaced them with a bignumber, so
a valid `0.00000003` printed as `3e-8` in the indexer log. `logAmount`
rewrites only values that already render that way. Nothing a client can
observe, submit or pre-check moves.

- **`send.js` - no client change.** Log-line rendering only.
- **`destroy.js` - no client change.** Log-line rendering only.
- **`mint.js` - no client change.** Log-line rendering only.
- **`dispenser.js` - no client change.** Log-line rendering only.
- **`order.js` - no client change.** Log-line rendering only.
- **`swap.js` - no client change.** Log-line rendering only.
- **`airdrop.js` - no client change.** Log-line rendering only.
- **`dividend.js` - no client change.** Log-line rendering only.
- **`dispense.js` - no client change, but NOT log-only; read this one.**
  Carries two edits from the earlier AML round beside the log wrap.
  (1) The fill-count divide now uses `bcfloorSaturating` instead of
  `bcfloor`. A dispenser priced at 1e-18 could drive
  `available / GET_AMOUNT` past 2^53-1, and the throw escaped `parse()`
  into the block loop, which rolled back and retried the same block
  forever. Saturating cannot change any client-predictable verdict: on
  every input that does not overflow the two helpers agree, and the
  behaviour it replaces on inputs that do is "no node commits this block
  at all", so no committed history can contain one. The `GIVE_REMAINING`
  clamp still bounds the result to real capacity. Nothing for
  `checks/dispenser.js` to mirror - a client cannot pre-check a condition
  whose old outcome was a wedged chain.
  (2) A local `data` shadowing `parse()`'s transaction object was renamed
  to `cdata`. Internal.

Separately, `LIST` gained a `MEMO` field in place on formats v0/v1 in
`58ab8e9`, positioned BEFORE the variadic `ITEM` tail. `list.js` is not in
this table - LIST is a `checks/misc.js` unverified-only action ("per-item
validity is recorded per-item on-chain, never a reject"), which the MEMO
addition does not change. Its client-side safety is the default-deny
`_checkDelimiters` guard, which already covers every field and is now
pinned for MEMO specifically by `test/unit/validator.test.js`.

### 2026-08-15 (sixth pass) - `dispense.js`, against indexer HEAD `07aaf8e`

One row, drifted by the 2026-08-15 xchain-platform review round (findings #4891
and #4894). The sibling `git status --short src/actions/` is empty and the
recorded hash equals the HEAD blob, so this is committed content and not a
working-tree artifact.

- **`dispense.js` - REAL change, NO client change owed.** Two edits, reviewed
  separately because only one of them can move a verdict.
  - **#4894 is a rename with no behaviour.** The synthetic DISPENSER_CLOSE
    payload built in the empty-close branch was a local named `data`, which
    shadowed `parse()`'s own transaction object for the rest of the block; it is
    now `cdata`, matching the MAX_DISPENSES branch below it, which already named
    it that way for the same reason. Same keys, same values, same
    `processAction` call. Nothing to mirror.
  - **#4891 replaces `bcfloor` with `bcfloorSaturating` on the non-FIAT
    multiplier, and the case it changes was never a verdict.** The two helpers
    agree on every input that does not overflow. On inputs that do, the OLD
    behaviour was a throw that fires before any status is recorded, escapes
    `parse()` into the block loop, and makes that loop roll back and retry the
    same block forever, so every indexer on the chain wedges rather than
    committing a block. Reachable for the price of two transactions: `GET_AMOUNT`
    is validated only against `GET_TICK`'s DECIMALS, a tick may be issued with up
    to 18 decimals, and a dispenser priced at 1e-18 triggered by a token SEND of
    ~0.01 drives `available / GET_AMOUNT` past 2^53-1. Because no node could
    commit such a block, no committed history contains one, and the client's
    pre-flight has nothing to predict differently: a valid dispense stays valid,
    an invalid one stays invalid, and the changed input class previously produced
    no verdict at all. The `GIVE_REMAINING` clamp already bounds the saturated
    count to the dispenser's real capacity. `checks/dispenser.js` prices no
    dispense (the 2026-07-26 entry's standing verdict) and mirrors no multiplier,
    so there is nothing client-side that could drift with it.

### 2026-08-15 (fifth pass) - `batch.js` and `issue.js`, against indexer HEAD `9d15127`

Two rows, and they end differently: one BUILDS the mirror the fourth pass
deferred, the other records a reviewed no-op. The sibling `status --short
src/actions/` is empty, so both recorded hashes are committed HEAD content.

**`batch.js` - the deferred mirror is now BUILT (row 11).** The fourth pass
deferred it on one stated condition: the weight table was mid-construction, with
DEPLOY's weight and the ratified EXECUTE/XEXEC weight still unwired in the
arbiter. Both landed (DEPLOY, EXECUTE and XEXEC at 30, budget 250), so the
condition is met and the mirror follows where that entry said it would:

- `batchLimits.js` gains `BATCH_WEIGHT_BUDGET`, `BATCH_COMMAND_WEIGHTS`,
  `subCommandWeight` and `batchWeight` as the single source, byte-equal to the
  arbiter's `weightBudget` and `commandWeights`.
- `decoder/parse.js` and `preflight/checks/batch.js` weigh a batch that already
  fits the count, in that order, which is the arbiter's own ordering and is
  sound because every weight is an integer >= 1.
- The weight overflow sits in the SAME else-chain as the count cap, so it
  suppresses per-action findings exactly as the on-chain budget check does by
  rejecting the whole batch before any per-action count is taken.

**The posture question that entry raised is answered: WARNING, not refusal.**
`batchBuilder.js` and `validator.js` are deliberately NOT given a weight
refusal. `BATCH_COST_WEIGHTING` is live on testnet and regtest from genesis and
UNARMED on mainnet, and a client has no chain height to tell them apart, so a
refusal would false-block legal mainnet work - the direction this module's
doctrine forbids. Pre-flight's existing warning shape is followed instead, and a
test asserts the severity so a later tightening cannot pass quietly.

**`issue.js` - reviewed, NO client move owed.** The change is
`EMISSION_ISSUANCE_LIMITS`: a per-transaction `ISSUANCE_LIMIT_LEDGER` counting
TOP-LEVEL issuances against a limit of 1. It is initialized in `actions.js` for
every action rather than only the VM paths, so reachability had to be checked
rather than assumed, and the conclusion is that its client-composable surface is
already mirrored:

- A wire transaction carries one ISSUE, which is one top-level issuance.
- A BATCH carrying two top-level ISSUEs is already refused by the per-action
  `ISSUE: 1` cap this module has always mirrored, so the new rule is redundant
  there rather than new.
- Its actual reach is VM-EMITTED issuances (`execute.js`, `deploy.js` and
  `xexec.js` thread the same ledger object, so nested executions share one
  tally), which a client cannot compose. XEXEC is not client-composable at all,
  which is the neighbouring finding this module already documents.
- The arbiter's `isTopLevelIssuance` treats a caret TICK as top-level even when
  it contains a dot. That is the same rule this module already states in its
  header and pins by conformance vector, so the classification agrees.

### 2026-08-14 (fourth pass) - `batch.js`, against indexer HEAD `a4ce1fc`

One row. `git log b460999..HEAD -- src/actions/batch.js` returns exactly two
commits, `013c206` ("bound a BATCH by a weighted cost budget instead of a command
count") and `d627a4b` ("weigh fan-out actions flat, with no read in the cap
scan"), and the sibling `status --short src/actions/` is empty, so the recorded
hash is committed HEAD content and the review range is exact.

**This one DOES owe a client move, and the move is deliberately not made here.**
That is a different outcome from every entry below it, so it is stated plainly
rather than left to be inferred from a refreshed hash.

- **What changed.** A new flag day, `BATCH_COST_WEIGHTING`, replaces the flat
  250-command cap with a budget over per-action COST WEIGHTS. Budget is 250 and
  the default weight is 1, so an ordinary batch is decided arithmetically
  identically to today, including the error string, which stays
  `invalid: COMMAND (limit)`. The count check survives as a pre-filter, which is
  sound because every weight is an integer >= 1. Two weights are assigned so far:
  `AIRDROP` and `DIVIDEND` at 25 each, flat rather than `1 + recipients`, because
  the recipient count is not on the wire and an exact count would need an as-of
  read per sub-command inside the very scan the budget exists to keep cheap.

- **Why it is client-visible.** Ten AIRDROPs weigh 250 and fit; eleven weigh 275
  and the whole batch rejects, where eleven sub-commands passed before. A client
  composing fan-out batches can now be refused on weight while it is still far
  under the command cap, and `checkCommandCap` in `checks/batch.js` cannot see
  that, because it counts commands.

- **Why the mirror is NOT built in this pass.** Two reasons, and the second is
  the decisive one:
  1. `BATCH_COST_WEIGHTING` is UNARMED on mainnet, on the house sentinel
     `9999999999` (year 2286), with no scheduled instant. Testnet and regtest
     activate at genesis, so the rule is live there and inert on mainnet.
  2. **The weight table is incomplete and known to be about to change.** Two
     weight classes are still unwired in the arbiter itself: DEPLOY's weight and
     the ratified EXECUTE/XEXEC weight. Mirroring the table today would pin a
     client to a table that is mid-construction, and every class added afterwards
     would re-break the mirror and this gate together. The client mirror is
     sequenced deliberately AFTER those classes land, not before.

  So this refresh records a REVIEWED DEFERRAL, not an assertion that nothing is
  owed. The distinction matters because a silent re-pin here would be exactly the
  failure this gate exists to prevent.

- **What the deferral costs, stated rather than discovered.** Until row 11 lands,
  a client composing an over-budget fan-out batch for testnet or regtest gets no
  client-side warning and learns from the chain's rejection. On mainnet it costs
  nothing, because the flag is unarmed there. That is the survivable direction
  this module already declares for its MINT approximation: the mirror may accept
  a batch the chain rejects, never the reverse.

- **What must happen before the mirror is built.** The remaining weight classes
  land in the arbiter, THEN `batchLimits.js` gains the budget and the weight table
  as its single source, and the four other `BATCH_COMMAND_LIMIT` sites follow it
  (`batchBuilder.js`, `validator.js`, `decoder/parse.js`,
  `preflight/checks/batch.js`). Note the posture question that work has to answer
  and this entry does not: `batchBuilder` and `validator` REFUSE on the command
  cap, and a refusal on a weight that is unarmed on mainnet would false-block
  legal mainnet work, which is the direction this module's own doctrine forbids
  (see the MINT approximation note above: the mirror may accept what the chain
  rejects, never the reverse). Pre-flight's existing WARNING shape is the
  precedent to follow.

Tracked as XC-1480.

### 2026-08-13 (third pass) - `batch.js` + `dispenser.js`, against indexer HEAD `b460999`

Two rows, one cause, and this time the cause is a single reviewable commit
rather than a repo-wide scrub: `b460999` ("pre-flight a batch per sub-command,
without opening the VM"). `git log 22f0f31..HEAD -- src/actions/batch.js
src/actions/dispenser.js` returns that commit and nothing else, and the sibling
checkout's `status --short src/actions/` is empty, so the hashes recorded above
are committed HEAD content and the review range is exact.

Both diffs are gated on `data['FEE_PROBE']`, which `actions.js` sets only on the
synthetic transaction the read-only quote surfaces build and never on a decoded
one. **So neither row moves a consensus verdict, and the client checks in
`checks/batch.js` and `checks/dispenser.js` owe nothing.** That is the same
shape as the 2026-07-26 `dispenser.js FEE_PROBE oracle fee` entry above, and it
is deliberately NOT the end of the review, because this change did something the
earlier probe-path changes did not: it created a response field the client had
no reading for.

- **`batch.js` - no Tier-2 change, but a new Tier-1 CONTRACT.** The diff seeds
  two probe-local collectors above the `baseKeys` snapshot (`PROBE_SUB_VERDICTS`,
  `PROBE_ORACLE_FEES`), refuses VM-reaching sub-actions immediately above the
  dispatch, clears `STATUS` before each dispatched sub-command so a handler that
  records none reports `null` instead of inheriting its predecessor's, and
  restores the BATCH's own `status` after the loop. Nothing there is a validity
  rule `checks/batch.js` mirrors: the command cap, the dotted-child exemption
  and the gas-budget projection are all untouched, and the batch-level verdict a
  client can compute is unchanged.
  **What DID change is what the endpoint answers, and it needed a client
  change:** `/preflight` now returns `subCommands` (each sub-command's own
  verdict, in list order) and, on refusal, `deniedSubAction`. The last line of
  the handler is the reason that matters - `data['STATUS'] = status` restores the
  BATCH's structural verdict, so the outer `valid` is TRUE for a batch whose
  commands the same response reports as invalid. Driven against the live BTC
  regtest indexer running this commit, 2026-08-13, blockIndex 14513:
  `BATCH|0|SEND|0|NOSUCHTOKENXYZ|1|<addr>` answers `valid:true, status:"valid"`
  with `subCommands:[{status:"invalid: TICK (unknown)"}]`. Reading only the outer
  field would have shown a network approval for a batch that does nothing, and
  would additionally have demoted every Tier-2 finding on it to info. That is
  what `TIER1_SUBCOMMAND_PREFLIGHT` and the per-sub-command precedence rule in
  `preflight/index.js` exist for; see `test/unit/preflight/batchTier1.test.js`.

- **`dispenser.js` - no client change, and the declared gap is unchanged.** The
  diff adds one probe-only block: when a Mode B DISPENSER's oracle fee is owed
  and above dust, it accumulates the amount into `PROBE_ORACLE_FEES` keyed by
  oracle address. It writes a probe-local object, never `BATCH_VALUE_LEDGER`,
  and it is inside the existing `if(data['FEE_PROBE'] ...)` shape rather than a
  new branch on the settlement path. `checks/dispenser.js` still cannot see
  outputs, so `DISPENSER_ORACLE_FEE` stays the declared-unverified gap it has
  been since 2026-07-26 - the client gained no ability to CHECK the fee.
  What it gained is the arbiter's own arithmetic for it: `oracleFeesOwed` is a
  DISCLOSURE, not a verdict (the probe carries no outputs, so it reports the
  total owed per oracle rather than judging an output set it does not have), and
  Tier 1 now surfaces it as `DRYRUN_ORACLE_FEES_OWED` info. Deliberately info
  and not an error: turning a disclosure into a verdict is exactly the
  false-block this severity model refuses, and the number is optimistic by
  construction on the arbiter's side too (it is a per-oracle SUM offered so a
  composer can size the outputs, not a claim that any output exists).

### 2026-08-13 (second pass) - all eleven rows, against indexer HEAD `22f0f31`

The entry below refreshed ONE row and left ten deliberately red, because the
baseline those ten were pinned at had not been established. This pass
establishes it and closes them. Every recorded hash was located as a concrete
BLOB in the sibling checkout's object store (six of the eleven are unreachable
objects, left behind when that repo's history was rewritten, which is why
`git log` could not find them and why a commit range alone would have been the
wrong tool), and each handler was diffed BLOB to HEAD and read end to end.
Verified against COMMITTED state: every recorded hash below equals the sibling
checkout's HEAD AND its working tree, with `git -C xchain-indexer status
--short src/actions/` carrying nothing mapped. `22f0f31` was `origin/master`
during the review; a local commit landed underneath it while this was being
written (`7259826`, batched COINPAY quoting) and touches `coinpay.js` only,
which is not a mapped row, so the pins are unchanged by it.

The dominant cause across the set is `758fc1d` ("style: comment cleanup,
internal-reference scrub, and changelog tidy"), which stripped internal issue
ids and section-banner comments from every handler in the repo ahead of the
public release. It moved eight of these eleven hashes and NOT ONE executable
line in them. That is worth naming rather than waving at: a scrub that touches
every mapped file at once is exactly the shape that tempts a blind re-pin, and
it is also the shape under which a real change rides in unnoticed. Three rows
did carry real change, and they are separated out below.

- **`send.js` - no client change.** Baseline blob `f84ce594` (`3808773`).
  Scrub only: banner and narration comments deleted, the PC-29 conditional-handoff
  box comment reflowed to line comments with its content intact, trailing newline
  restored. No condition, threshold, precedence or rejection string moved.
- **`destroy.js` - no client change.** Baseline blob `f144f038` (`db6ce39`,
  2026-06-20, the oldest pin in the table). Comment deletions only; zero
  executable lines differ across nearly two months.
- **`mint.js` - no client change.** Baseline blob `ed5d916e` (the 2026-08-12
  pin). Scrub only. Specifically, the `UNCAPPED_MAX_SUPPLY_ZERO` block that the
  2026-08-12 entry changed `checks/mint.js` for is byte-identical here; only its
  comment lost an issue id, so that entry's verdict stands unrevisited.
- **`issue.js` - REAL change, no client change owed.** Baseline blob
  `ace76608`; `fe3bac7` + `b090671` on top of the scrub. Two additions, both
  gated on `BATCH_ISSUANCE_LIMITS`. (1) A new rejection,
  `invalid: TICK (caret dot)`: the handler's own caret guard is `isNumeric`,
  which is parseFloat-based, so `^12.5` read as a number and landed a valid ISSUE
  with a NULL ticker id. Client-visible, and no mirror is owed because
  `validator._validateTickName` refuses EVERY `^`-led ISSUE TICK, which is
  strictly stronger than the caret-dot subset. That argument is the load-bearing
  one on this row and it was previously only prose, so it is now PINNED by
  `test/unit/validator.test.js` ("rejects a caret ISSUE TICK whose tail contains
  a dot"): if the SDK ever narrows to match the chain's rule literally, the claim
  fails loudly instead of silently. (2) `gatedGetTokenInfo` suppresses interning
  an unseen tick into `index_tickers` once `error` is already set. The value
  handed back is unchanged by construction (a not-yet-interned tick reads back as
  unknown either way), so it is a database side effect with no wire-visible
  verdict and nothing to mirror.
- **`dispenser.js` - no client change.** Baseline blob `5e9c791b` (the
  2026-08-12 pin). `758fc1d` plus `cb3e3cd`, whose hunk here is a comment. The
  `GIVE_ESCROW`-on-ownership-dispenser rejection and the `MAX_REFILLS` cap that
  the 2026-07-26 and 2026-08-12 entries mirrored are byte-identical.
- **`dispense.js` - REAL change, no client change owed.** Baseline blob
  `b1eef653` (`ef66d9e`, 2026-07-26), so this row had never advanced past the
  `DISPENSER_ORACLE_PER_TOKEN_PRICE` work the 2026-07-26 entry already reviewed;
  that verdict (settlement pricing, and the client does not price dispenses)
  is unchanged. New on top, from `fe3bac7` and `65d57b4` and gated on
  `BATCH_ISSUANCE_LIMITS`: a running consumed-value tally so one payment settles
  a bounded number of FILLS instead of buying a full multiplier against every
  dispenser it reaches, inside a batch and (65d57b4) outside one, where several
  open dispensers can sit behind a single paid address. It creates reachable
  rejections on a LATER dispenser in that loop and it rewrites the dispense row's
  `GET_AMOUNT` to the attributed cost rather than the whole payment. Neither is
  checkable at Tier 2, and the reason is structural rather than awkward: the
  tally is keyed on `COIN_AMOUNT` and on the SET of open dispensers behind the
  paid address, while pre-flight is handed an action string naming one dispenser
  BEFORE any transaction, and therefore any payment value, exists. It lands
  inside the standing `DISPENSE_SETTLEMENT_MATCH` unverified, whose rationale
  comment in `checks/dispenser.js` now names it, the same treatment the
  2026-08-08 entry gave `DISPENSER_ORACLE_FEE`. The record half has no client
  consumer either: `resolveGiveRemaining` reads the GIVE-token side, and nothing
  in `preflight/` reads a dispense `get_amount`.
- **`order.js` - no client change.** Baseline blob `7637c2b2`. Scrub only,
  including one comment that traded an internal defect number for the reason it
  stood for (BigNumber negation, not JS unary minus). No verdict moved.
- **`swap.js` - no client change.** Baseline blob `c5242908`. Scrub only, plus
  a restored trailing newline.
- **`airdrop.js` - no client change.** Baseline blob `77904a45` (the
  2026-08-12 pin). Scrub only: the Set-backed allow/block membership that the
  2026-08-10 and 2026-08-12 entries reviewed is byte-identical, its comment
  merely shortened.
- **`dividend.js` - no client change.** Baseline blob `6142ac8c` (`ef66d9e`,
  2026-07-26). Comment deletions and one doubled `// //` marker fixed.
- **`batch.js` - client check ALREADY MOVED, and driven.** Baseline blob
  `312a1fef` (`60683a0`), so this row is only three commits stale and all three
  are client-visible. `581aea1` adds a GATED per-action cap of one DEPLOY per
  batch (kept in a second table so DEPLOY stays uncapped below the flag, as it
  always was) and re-reads MINT's existing 1 as one per DISTINCT TOKEN rather
  than one per batch, keyed on the RESOLVED ticker id. `bdbdc1d` DECLARES the
  precedence among per-action caps: the error names the action whose first
  sub-command appears earliest in the command LIST, taken from the list rather
  than from a tally's key enumeration. All three are already mirrored in
  `src/batchLimits.js` (`BATCH_GATED_ACTION_LIMITS`, `maxMintsPerDistinctTick`,
  `limitKeysInListOrder`) by the paired client-parity work, including the two
  divergences a string-keyed client cannot close (the caret alias, reported as
  approximate; unresolvable ticks, declared). Not taken on trust:
  `test/unit/batchLimitsConformance.test.js` drives the REAL arbiter out of the
  sibling checkout over one shared vector set and compares classification, count,
  precedence and whole-batch verdict against the mirror, and it is green at this
  HEAD.

Net: one test added and one rationale comment widened. No client check's LOGIC
moved in this pass, which is the outcome eight comment-only diffs and three
gated tightenings should produce - but it is the outcome only because it was
checked per handler, which is the whole point of the entry.

### 2026-08-13 - `batch.js` only (BATCH issuance limits), and why the rest stays red

> Superseded by the entry above: the ten rows this entry left deliberately red
> have since been ground-truthed against indexer HEAD `22f0f31` and refreshed.
> Its reasoning for leaving them red at the time still stands, and its
> `batch.js` review remains the record for that row's earlier state.


The gate is red across ELEVEN handlers, fleet-wide and for unrelated reasons
(tracked as XC-1453). This entry refreshes exactly ONE row, `checks/batch.js`,
because that is the only handler whose diff was read end to end and whose client
mirror moved with it. The other ten rows are deliberately left red: their
recorded hashes predate a baseline this review did not establish, and refreshing
a row nobody read is the failure this log exists to prevent.

Read: `src/actions/batch.js` at `105dfbf` (the BATCH_ISSUANCE_LIMITS work,
`74c6780` + `d71c851` + `105dfbf`). Four client-visible rules, all now mirrored
through one shared client copy of the scan, `src/batchLimits.js`:

- **Dotted-TICK exemption.** At most one TOP-LEVEL (undotted) ISSUE per BATCH,
  plus any number of children. A caret TICK is never exempt even when it
  contains a dot. Classification reads params[1] of the NORMALIZED sub-command,
  so a legacy no-VERSION command classifies off the same TICK the executor sees.
  Mirrored in `batchBuilder.js`, `validator.js` and `decoder/parse.js`.
- **250-command cap, checked FIRST.** The count is the raw `';'`-split list with
  empty elements included, and its precedence is pinned: a batch breaking the cap
  AND the ISSUE limit reports the cap. Mirrored at all four sites. Pre-flight
  raises it as a WARNING, not an error: the rule arrives with a flag-day, the
  client has no height, and an over-cap batch is still accepted where the flag
  has not armed.
- **Case sensitivity.** The arbiter matches action names case-sensitively and
  kills `issue|0|A;issue|0|B` on the activation scan, not the ISSUE limit. The
  mirror classifies before any upper-casing for exactly that reason.
- **Aggregate gas pre-check** (`isGasProvablyUnaffordable`, `invalid: GAS
  (insufficient)`). Mirrored in `checks/batch.js` as an ERROR, on the arbiter's
  own predicate: the MINIMUM, never the sum, and only when EVERY sub-command is
  a positively-priced new-tick ISSUE. Gas is billed greedily in list order, so a
  source with gas for K of N lands K commands; a sum-based rejection would refuse
  a transaction the chain accepts. The partially-funded case is a warning naming
  K. Scope bail-outs mirrored: any non-ISSUE command, a caret TICK, the gas tick
  itself, an existing TICK (a re-issue is free), and the native/rejected fee
  modes all disable the collapse verdict.

Also read but NOT re-pinned: `src/actions/issue.js`, which gained the caret-dot
TICK rejection and the intern gating in the same train. No client change is owed
and none was made: the SDK validator already refuses ANY `^`-led TICK on ISSUE
(`_validateTickName`), which is strictly stronger than the caret-dot rule, and
the intern gating is a database side effect with no wire-visible verdict. Its row
keeps its stale hash rather than gaining a refresh this review did not earn.

Conformance for all of the above is `test/unit/batchLimitsConformance.test.js`,
which drives the REAL arbiter from the sibling checkout over a shared vector set
and compares classification, count and whole-batch verdict.

### 2026-08-08 - nine handlers, mostly one rule

The gate's second real firing, and it had been red on master for two weeks
unread. Cause is in the wiring, not the map: the gate ran only in CI, so a
local `npm test` never showed it, and it is now step one of `npm run ci`
(still skipping clean when there is no sibling checkout). Verified against
COMMITTED state on both sides before anything was refreshed.

Nine handlers, one dominant rule. **Caret-ref strict activation** turns
an unresolvable wire `^<id>` address reference into a hard
`invalid: <FIELD> (unresolvable ^id)` at/after each chain's flag-day
(`caret_ref_strict_activation.js`; regtest armed from genesis, mainnet on a
later flag-day train). It lands on `mint.js` DESTINATION, `issue.js` TRANSFER and
TRANSFER_SUPPLY, `order.js` and `swap.js` GET_ADDRESS, and `dispenser.js`
GET_ADDRESS and ORACLE_ADDRESS. Client-visible, and partly client-decidable,
so it is mirrored as a new universal check (`preflight/universal.js`,
`CARET_REF_UNRESOLVABLE`):

- A **non-canonical** id (`^0`, `^007`, `^abc`, bare `^`) fails the indexer's
  own `CANONICAL_CARET_ID` and can never resolve on any node, so the client
  knows the verdict with no lookup and says so.
- A **dangling but well-formed** id is the same rejection with no local
  evidence: the explorer maps address -> id and nothing maps the inverse, so
  it is declared unverified rather than guessed at.
- **Exception, on the `noCompact` fields only.** A well-formed id on
  DISPENSER.GET_ADDRESS or DISPENSER.ORACLE_ADDRESS is decidable after all and
  is reported rather than declared unverified, because the DECODER refuses the
  reference whatever it points at: its address ids are a different
  AUTO_INCREMENT sequence, so a compacted GET_ADDRESS registers no dispenser
  (`XChainDecoder.js`) and a compacted ORACLE_ADDRESS captures no oracle-fee
  output, leaving the create rejected after the fee is spent
  (`oracleFeeOutput.js`). The field set is DERIVED from the `noCompact` specs in
  `addressRefFields.js`, and the branch is per-ACTION, so ORDER/SWAP GET_ADDRESS
  keeps the unverified verdict. Still a warning, and the validator stays silent:
  the chain itself accepts the transaction.
- **Warning, never an error**, including the decidable half. Three call sites
  had no follow-up format check before this activation (DISPENSER.ORACLE_ADDRESS on a
  non-oracle dispenser, ISSUE.TRANSFER/TRANSFER_SUPPLY on the genesis path,
  DEPLOY.SLASH_DESTINATION below its own flag-day), so those actions are still
  ACCEPTED below the activation height, and pre-flight has no chain height to
  gate on. A hard client error would false-block them.
- The scoped field set is DERIVED from the shared `addressRefFields.js`
  consensus map (single-value, non-type-gated), not listed again. That
  derivation is exact today, and the two excluded shapes are excluded for
  reasons that also make them wrong to flag: SEND.DESTINATION is `multi` and
  `send.js` is the one address-bearing handler that never resolves at all,
  and LIST.ITEM holds an address only when the list TYPE says so.

The rest, none of which moves a client check:

- **`send.js` conditional gated handoff (PC-29).** A gated pack now
  compels a key-handoff MESSAGE only when the recipient's POST-SEND balance
  reaches the pack threshold, instead of every send of a gated tick requiring
  one. Deciding it needs the destination's pre-send balance at
  (BLOCK_INDEX, ACTION_INDEX) and the tick's pack thresholds, neither
  reachable from an action string, and it strictly NARROWS an existing
  rejection. The `SEND_RESTRICTIONS` declaration now names it as conditional.
- **`issue.js` LOCK_NULL_PRIOR_UNSET.** An absent/NULL prior lock
  reads as unset rather than falling through to "locked", resolved once per
  action so the gate cannot differ field to field. Another narrowing, already
  inside `ISSUE_LOCK_RATCHETS`.
- **`dispenser.js` FEE_PROBE oracle fee.** Changes the DRY-RUN half
  only: a read-only quote has no outputs, so the output half of
  `validateOracleFee` could only ever fail there while demanding the amount
  the refused quote existed to compute. Tier 1 now answers for a Mode B
  dispenser instead of refusing. Tier 2 still cannot see outputs, so
  `DISPENSER_ORACLE_FEE` stays the declared gap; its rationale comment records
  what changed underneath it.
- **`getList(..., BLOCK_INDEX)` list-edit resolution** in
  `dividend.js`, `airdrop.js` and `dispense.js`: list membership resolves at
  the processing block instead of live. Membership was already server-side and
  declared unverified on all three; no verdict the client can see moves.
- **`mint.js` / `issue.js` / `order.js` / `swap.js` / `dividend.js` residue:**
  per-tick memoization of `isActionAllowed`, destination-balance batching, and
  comment trims. No verdicts.
- **`airdrop.js`:** comment trims plus the controller-guard reserve ordering,
  both already covered by `AIRDROP_TOTAL_VS_BALANCE`. No verdicts.

### 2026-08-08 - what the gate covers, stated honestly

The hash rows above cover per-handler files under `src/actions/` only. On top
of them `bin/check-preflight-drift.js` now compares four things by VALUE:

- `FEE_QUOTE_DENYLIST` == `TIER1_DENYLIST`
- `FEE_QUOTE_STATIC` is a subset of `TIER1_DENYLIST`
- no action is both indexer-`FEE_QUOTE_EXEMPT` and SDK-`FEE_CHARGING_ACTIONS`
  (the omission that let BET ship with no forfeiture disclosure)
- `GAS_SCHEDULE` agrees between `xchain-indexer/src/coins/<C>.js` and this
  SDK's own copy, for BTC/LTC/DOGE

NOT covered, deliberately: that every indexer handler calling
`createFeesObject` appears in `FEE_CHARGING_ACTIONS` (that set is a call-site
property, not a literal, so it needs an AST walk); `classifyFeeQuoteAction`'s
normalize/deny-before-exempt ordering; and `_staticProtocolFee`'s arithmetic.
Gating those means hashing a function body, which is the anchor-scoped hashing
this file's own rationale rejects for financial logic.

> Partly superseded by the 2026-08-11 entry below: the `createFeesObject`
> coverage direction is now checked, and it needed a file-level call-site walk
> rather than the function-body hash this paragraph assumed. `_staticProtocolFee`'s
> arithmetic is bound too, though the conclusion here holds for it: gating it from
> this gate would need a body hash, so it is bound in the indexer instead, by a
> parity test over the one helper all four fee sites now call.

### 2026-07-26 - `dispenser.js` (`aac9038`..HEAD), `dispense.js` (`bbaaeeb`..HEAD)

First real firing of this gate. It went red because it was never wired into
either repo's CI, so four handlers had moved since the map was written; two
of those (`airdrop.js`, `dividend.js`) turned out to match HEAD and were
reporting only an uncommitted sibling worktree, and their hashes are
unchanged here.

`dispenser.js`, changes with a client-visible verdict:

- **Oracle usage fee on open and refill.** New rejection: a Mode B
  dispenser (one naming an `ORACLE_ADDRESS`) must pay the oracle operator a
  native-coin output sized from the escrow this action adds, and the handler
  rejects when it is missing or below the tolerance band. Tier 2 cannot check
  it *in principle* - the rule is about transaction OUTPUTS and pre-flight is
  handed an action string - so `checks/dispenser.js` now declares
  `DISPENSER_ORACLE_FEE` unverified on both the v0 open and the v2 refill.
  The enforcing layer is the wallet at compose time
  (`core/src/sdk/oracleFeePreflight.js`), which hard-refuses an unquotable
  Mode B dispenser.
- **MAX_REFILLS cap.** New rejection: the 6th format-2 edit that
  tops up `GIVE_ESCROW`. Mirrored as a `DISPENSER_MAX_REFILLS` **warning**
  (client cannot see whether the flag-day gate is live for the landing
  block, so an error could false-block a legal refill), counted from
  `getDispenserEdits` with the same `give_escrow > 0` predicate as
  `db.getDispenserRefillCount`.
- **Freshness causality flag-day.** Changes how origin freshness is
  decided (indexer-local chain state instead of the utxo-tracker), not
  whether. Already covered by the existing `DISPENSER_ORIGIN_STANDING`
  unverified; no client change.
- **Expiration-edit divergence counter.** Observability only; no verdict.

`dispense.js`, changes with a client-visible verdict:

- **`FIAT_DISPENSER_PRICING` gate.** New `invalid: FIAT dispenser pricing not
  active` rejection, but the flag is genesis-active on every network, so the
  branch is unreachable in practice. No client change.
- **Multiplier clamp replacing the decrement loop.** Identical by
  construction (the loop's fixed point is `min(multiplier, floor(remaining /
  give_amount))`); a performance fix. No client change.
- **`DISPENSER_CLOSE_PER_UNIT` flag-day.** Auto-close now triggers
  when remaining cannot cover ONE unit rather than the triggering dispense's
  aggregate. The client's `DISPENSER_EMPTY` check already compared against
  the per-unit `give_amount`, so it agrees with the post-flag-day rule.
- **MAX_DISPENSES auto-close.** Emits a real `DISPENSER_CLOSE`, so
  `resolveDispenserState` resolves such a dispenser `closed` off the existing
  close stream regardless of the new `max_dispenses_reached` status string.
  No client change.
- **Validator pair keyed on `GET_COIN`.** Settlement pricing detail; the
  client does not price dispenses. No client change.
- **`DISPENSER_ORACLE_PER_TOKEN_PRICE` flag-day.** Mode B (a dispenser naming
  an `ORACLE_ADDRESS`) now divides the affordable token count by `GIVE_AMOUNT`
  to get whole fills, so a PRICE v1 quote is the price of one TOKEN rather
  than of one whole fill. Settlement pricing again, and the client does not
  price dispenses, so no new verdict: preflight cannot know the landing
  block's oracle price in any case. It DOES change what a buyer owes by a
  factor of `GIVE_AMOUNT`, so any surface that quotes a Mode B price to a
  human must multiply the quote by `GIVE_AMOUNT` to state a fill price (the
  wallet's `DispenserDetail` buy panel does).

Reviewing the refill mechanics also surfaced a pre-existing client defect
that had nothing to do with these diffs: `resolveGiveRemaining` rebuilt
give-remaining as `opening escrow - dispenses`, ignoring refills, which
under-reports a refilled dispenser and raises a false `DISPENSER_EMPTY`
error on a DISPENSE - an action that moves native coin and that Tier 1
cannot cover. It now prefers the explorer's live `state.give_remaining`
(escrow + refills - dispenses) and, on the fallback path, adds refills back
in; when the edit stream is unreachable it reports unverified rather than a
number it knows is low.

### 2026-08-10 - AIRDROP recipient membership became set-backed

`src/actions/airdrop.js` changed and the gate correctly demanded a paired
review. The diff converts `recipients` and `approved` from arrays to `Set`s and
switches three `.length` reads to `.size`, because membership was tested with
`Array.indexOf` per recipient on the synchronous per-block path for a list the
indexer's own mapper comments as carrying thousands of addresses.

No verdict the client can see moves, and the reasons are specific rather than
"it is only a refactor":

- Membership resolution here is server-side and already declared unverified,
  the same standing this file records for the `getList(..., BLOCK_INDEX)`
  list-edit resolution change across `dividend.js`, `airdrop.js` and `dispense.js`.
- The counts feeding `AIRDROP_TOTAL_VS_BALANCE` are unchanged. `recipients` is
  reassigned to the deduped `approved` before any length read, so DEBIT and both
  fee branches already saw a deduped count; a `Set` yields the identical count.
- Credit ordering is unchanged, which matters because this is a consensus path.
  A `Set` was chosen over the object-keyed idiom `dividend.js` uses precisely
  because `Set` guarantees insertion order.

Not covered by this entry, and deliberately left alone by the fixing lane: the
same loop still does `recipientAllowList.includes` and `recipientBlockList.includes`
per recipient, the same O(n x m) shape. That gap is tracked separately and, when
fixed, will move this hash again and need its own line here, but it is the same
argument: server-side membership, already unverified.

### 2026-08-11 - three proxies replaced by the value they stood in for

No handler moved. One shared cause: a mapped handler hash was standing in for
something it structurally cannot cover (a value read by symbol, a set that is not a
literal, an arithmetic expression), so each is now bound to its authoritative source
instead. The first two are gate legs; the third is bound in the indexer, because the
thing it stands in for cannot be read from outside that repo.

- **Fee-charging coverage is bidirectional.** `checkFeeQuoteSeam` now
  derives the fee-charging set by walking `xchain-indexer/src/actions/*.js` for
  `createFeesObject` callers, unions the gas-priced `DEPLOY`/`EXECUTE` pair, and
  asserts set-equality against `FEE_CHARGING_ACTIONS`. Only the exempt-contradiction
  direction was bound before, which is the direction BET's omission did NOT trip.
  The 2026-08-08 entry declined this on the grounds that it needs an AST
  walk and therefore a function-body hash; that was wrong on both counts. Charging
  a fee is a per-FILE property here (a handler either calls the helper or does
  not), and the gate already reads every one of those files, so a comment-stripped
  text walk answers it exactly. An empty walk fails CLOSED, and the basename ->
  action mapping holds for all nine current callers (airdrop, bet, callback,
  dispenser, dividend, issue, order, swap, sweep); a future handler whose basename
  is not its action name surfaces as a named CI red, not as silent drift.
- **`MAX_REFILLS` is compared by value.** The SDK comment claimed the
  `src/actions/dispenser.js` hash caught a change to the refill cap. It does not:
  the cap is `config['MAX_REFILLS']` in `xchain-indexer/src/config.js` and the
  handler only reads it by symbol, so the cap can move with every mapped hash
  unchanged. New `checkConfigConstants` leg compares the two literals by value and
  fails closed if either cannot be read exactly once; the false comment in
  `src/preflight/constants.js` now names the real source and the real check.

- **Static VM fee arithmetic is bound on the indexer side.**
  `_staticProtocolFee` reproduced, by inspection only, the acceptance arithmetic of
  `deploy.js` / `deploy_chunk.js` / `execute.js`, and none of those three is a mapped
  row here. A term added to one and not the others would have quoted a client a
  native output the handler then refuses. Fixed where the arithmetic lives rather
  than here: the four sites now call one pure `util.vmGasCost(schedule, family,
  bytes)`, and `xchain-indexer/test/unit/vmGasParity.test.js` drives the static quote
  and the handler-side call from identical DEPLOY v0/v1, v2/v3, v4 and EXECUTE
  fixtures, then scans all four sources so no site can re-inline a `VM_` gas key.
  Deliberately NOT a gate leg: nothing this gate reads from the outside proves two
  arithmetic expressions agree, and hashing those three handler bodies is the
  anchor-scoped hashing this file's own rationale rejects for financial logic.

Still NOT covered, and unchanged by this entry: `classifyFeeQuoteAction`'s
normalize/deny-before-exempt ordering.

### 2026-08-12 - `mint.js`, `issue.js`, `dispenser.js`, `airdrop.js`

Four rows moved at once, by two indexer commits, and the four verdicts differ.
Recorded per handler rather than as one refresh, because "the gate went red and
the hashes were updated" is exactly the non-review this file exists to prevent.

- **`mint.js` - client check CHANGED.** The handler now skips the
  MAX_SUPPLY ceiling when no positive cap is declared, gated on
  `UNCAPPED_MAX_SUPPLY_ZERO`: MAX_SUPPLY is stored as 0 when an ISSUE omits it and
  0 is the UNCAPPED sentinel, so the old comparison made an uncapped token
  unmintable. `checks/mint.js` had the mirror-image defect and it was live, not
  theoretical: `tokenField` returns STRINGS and `'0'` is truthy, so the headroom
  path ran with maxSupply=0, computed a NEGATIVE headroom, and raised
  SUPPLY_EXCEEDED (a certified error-capable, network-class code) on every mint of
  an uncapped token. At/after the flag-day that is a false block of a valid action,
  which spec §4.2 forbids. Now guarded with `numeric.isPositive`, the same shape the
  MAX_MINT cap two lines above already used, and the uncapped case is DECLARED
  unverified rather than dropped, because below the flag-day the handler still
  rejects and pre-flight has no height to tell the eras apart.
- **`issue.js` - no client change needed.** The same exemption lands on
  three cross-checks (MINT_SUPPLY > MAX_SUPPLY, the cumulative MINT_SUPPLY cap, and
  MINT_ADDRESS_MAX > MAX_SUPPLY). `checks/issue.js` mirrors NONE of the three: it
  carries only the MAX_SUPPLY amount-format check and the NOT_OWNER guard. A
  loosening with no client counterpart cannot false-block, so the correct paired
  action is this note. If any of those three is ever mirrored client-side, the
  uncapped exemption has to come with it.
- **`dispenser.js` - client check ADDED.** A new client-visible
  rejection: a format-2 edit of an ownership dispenser that supplies GIVE_ESCROW is
  `invalid: GIVE_ESCROW (must be empty when GIVE_OWNERSHIP=1)`, gated with the
  dispenser-family cohort. The create-time half of this rule was already in
  `validator.js`, but that path is authoring-only and guarded on an EMPTY
  DISPENSER_ACTION_INDEX; an edit targets the dispenser by index and never restates
  GIVE_OWNERSHIP, so only a state lookup can see it. Added to `checks/dispenser.js`
  as DISPENSER_OWNERSHIP_ESCROW, ahead of the refill early-return because the
  handler guards with `isNull` and not `isPositive`, so a supplied zero still
  trips it while the refill path ignores it. WARNING, never an error, for the
  activation reason above. This row was already stale before this review: the
  pin matched `94f1a8f~1`, so the SDK lane had been unpushable independently.
- **`airdrop.js` - no client change needed.** Allow/block membership
  moved from array `includes` to `Set.has`, which the 2026-08-08 entry at the top of
  this file predicted would move this hash. The handler's own comment states the
  approved set is unchanged, and the diff bears that out: same `recipients`
  iteration, same insertion order, an empty list stays truthy as a Set exactly as it
  was as an array. Performance only, no verdict moves, nothing to mirror.
