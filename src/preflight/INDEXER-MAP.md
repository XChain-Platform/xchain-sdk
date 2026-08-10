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

Ground-truthed against HEAD 2026-07-20; `dispenser.js` and `dispense.js`
re-reviewed against HEAD 2026-07-26, and nine handlers re-reviewed
against HEAD 2026-08-08 (see the review log below). Hashes
are of the indexer handler source files, resolved via
`XCHAIN_INDEXER_PATH` or the sibling `../xchain-indexer` checkout. The
gate SKIPS (does not fail) when no indexer checkout is present, so
single-repo CI stays green; the sibling CI job enforces it.

Note when running this locally: the gate hashes the sibling WORKING TREE,
so an uncommitted edit in `xchain-indexer` reports as drift. CI checks out
HEAD, so CI sees only committed change. Hashes recorded here are always
HEAD hashes.

| Client check module | Indexer handler | SHA-256 |
|---|---|---|
| `checks/send.js` (SEND) | `src/actions/send.js` | `80248c76b126f2dffcd60e48b1efa29a27a87d9ceb1d424fe9b9ec7a0e70b94d` |
| `checks/send.js` (DESTROY) | `src/actions/destroy.js` | `effe81706519b936fc59a6f3313ee54851830f3fcd5e68fb918e5972df53092a` |
| `checks/mint.js` | `src/actions/mint.js` | `e628fdb52ea17c9ae21671f1a1af4cf6cd75818c99c15753c763bf16fdedbf62` |
| `checks/issue.js` | `src/actions/issue.js` | `d17904a409625a5dd1a238f9568e4ec1deb070fc2ae010837212a66da6d292bf` |
| `checks/dispenser.js` (open/edit/close) | `src/actions/dispenser.js` | `7bca355a41eeca8f0b374561371d7047721f1c9b16f5ce55ab7406b5235b188e` |
| `checks/dispenser.js` (DISPENSE) | `src/actions/dispense.js` | `2e4030e8e6d2ffa640eac4b4e56b4e039527ee2075694cc8cb765d43ad829a5c` |
| `checks/trading.js` (ORDER) | `src/actions/order.js` | `5de3d605bfcfe1e4fbc4b0a6a6a59bf50cd8c26c1c44c29958222ac5b2bf6256` |
| `checks/trading.js` (SWAP) | `src/actions/swap.js` | `8aa0582811749af3ff31ef37ba0793fe6ae061dc401ffb75e9a4291a1863b3cb` |
| `checks/airdrop.js` | `src/actions/airdrop.js` | `81f82e180a015cbe0bdd5b7a0529d989938795c601742ee7b239445337ded01b` |
| `checks/dividend.js` | `src/actions/dividend.js` | `44bf41e12afcb78717cf6705aedaaa1a3a3940cc34462be1ba5c605b74e72941` |
| `checks/batch.js` | `src/actions/batch.js` | `58269829cb68f5065256544ba134fda0f1dc00491653d25b4b330f1ec035ef64` |

Actions covered by `checks/misc.js` (unverified-only, no client validity
logic) are intentionally NOT mapped: there is nothing to drift from.

## Review log

A hash refresh is only honest if someone actually read the diff. What was
read, and what it changed on the client side, goes here.

### 2026-08-08 - nine handlers, mostly one rule 

The gate's second real firing, and it had been red on master for two weeks
unread. Cause is in the wiring, not the map: the gate ran only in CI, so a
local `npm test` never showed it, and it is now step one of `npm run ci`
(still skipping clean when there is no sibling checkout). Verified against
COMMITTED state on both sides before anything was refreshed.

Nine handlers, one dominant rule. ** caret-ref strict activation** turns
an unresolvable wire `^<id>` address reference into a hard
`invalid: <FIELD> (unresolvable ^id)` at/after each chain's flag-day
(`caret_ref_strict_activation.js`; regtest armed from genesis, mainnet on the
 train). It lands on `mint.js` DESTINATION, `issue.js` TRANSFER and
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
- **Warning, never an error**, including the decidable half. Three call sites
  had no follow-up format check before  (DISPENSER.ORACLE_ADDRESS on a
  non-oracle dispenser, ISSUE.TRANSFER/TRANSFER_SUPPLY on the genesis path,
  DEPLOY.SLASH_DESTINATION below its own flag-day), so those actions are still
  ACCEPTED below the activation height, and pre-flight has no chain height to
  gate on. A hard client error would false-block them.
- The scoped field set is DERIVED from the shared `addressRefFields.js`
  consensus map (single-value, non-type-gated), not listed again. That
  derivation is exact today, and the two excluded shapes are excluded for
  reasons that also make them wrong to flag: SEND.DESTINATION is `multi` and
  `send.js` is the one address-bearing handler that never resolves at all
  , and LIST.ITEM holds an address only when the list TYPE says so.

The rest, none of which moves a client check:

- **`send.js` conditional gated handoff (PC-29 / ).** A gated pack now
  compels a key-handoff MESSAGE only when the recipient's POST-SEND balance
  reaches the pack threshold, instead of every send of a gated tick requiring
  one. Deciding it needs the destination's pre-send balance at
  (BLOCK_INDEX, ACTION_INDEX) and the tick's pack thresholds, neither
  reachable from an action string, and it strictly NARROWS an existing
  rejection. The `SEND_RESTRICTIONS` declaration now names it as conditional.
- **`issue.js` LOCK_NULL_PRIOR_UNSET .** An absent/NULL prior lock
  reads as unset rather than falling through to "locked", resolved once per
  action so the gate cannot differ field to field. Another narrowing, already
  inside `ISSUE_LOCK_RATCHETS`.
- **`dispenser.js` FEE_PROBE oracle fee .** Changes the DRY-RUN half
  only: a read-only quote has no outputs, so the output half of
  `validateOracleFee` could only ever fail there while demanding the amount
  the refused quote existed to compute. Tier 1 now answers for a Mode B
  dispenser instead of refusing. Tier 2 still cannot see outputs, so
  `DISPENSER_ORACLE_FEE` stays the declared gap; its rationale comment records
  what changed underneath it.
- **`getList(..., BLOCK_INDEX)` ( list-edit resolution)** in
  `dividend.js`, `airdrop.js` and `dispense.js`: list membership resolves at
  the processing block instead of live. Membership was already server-side and
  declared unverified on all three; no verdict the client can see moves.
- **`mint.js` / `issue.js` / `order.js` / `swap.js` / `dividend.js` residue:**
  per-tick memoization of `isActionAllowed`, destination-balance batching, and
  comment trims. No verdicts.
- **`airdrop.js`:** comment trims plus the controller-guard reserve ordering,
  both already covered by `AIRDROP_TOTAL_VS_BALANCE`. No verdicts.

### 2026-08-08 - what the gate covers, stated honestly (#3934)

The hash rows above cover per-handler files under `src/actions/` only. On top
of them `bin/check-preflight-drift.js` now compares four things by VALUE:

- `FEE_QUOTE_DENYLIST` == `TIER1_DENYLIST` (#3833)
- `FEE_QUOTE_STATIC` is a subset of `TIER1_DENYLIST` (#3831)
- no action is both indexer-`FEE_QUOTE_EXEMPT` and SDK-`FEE_CHARGING_ACTIONS`
  (#3934; the omission that let BET ship with no forfeiture disclosure, #3893)
- `GAS_SCHEDULE` agrees between `xchain-indexer/src/coins/<C>.js` and this
  SDK's own copy, for BTC/LTC/DOGE

NOT covered, deliberately: that every indexer handler calling
`createFeesObject` appears in `FEE_CHARGING_ACTIONS` (that set is a call-site
property, not a literal, so it needs an AST walk); `classifyFeeQuoteAction`'s
normalize/deny-before-exempt ordering; and `_staticProtocolFee`'s arithmetic.
Gating those means hashing a function body, which is the anchor-scoped hashing
this file's own rationale rejects for financial logic.

### 2026-07-26 - `dispenser.js` (`aac9038`..HEAD), `dispense.js` (`bbaaeeb`..HEAD)

First real firing of this gate. It went red because it was never wired into
either repo's CI, so four handlers had moved since the map was written; two
of those (`airdrop.js`, `dividend.js`) turned out to match HEAD and were
reporting only an uncommitted sibling worktree, and their hashes are
unchanged here.

`dispenser.js`, changes with a client-visible verdict:

- **Oracle usage fee on open and refill .** New rejection: a Mode B
  dispenser (one naming an `ORACLE_ADDRESS`) must pay the oracle operator a
  native-coin output sized from the escrow this action adds, and the handler
  rejects when it is missing or below the tolerance band. Tier 2 cannot check
  it *in principle* - the rule is about transaction OUTPUTS and pre-flight is
  handed an action string - so `checks/dispenser.js` now declares
  `DISPENSER_ORACLE_FEE` unverified on both the v0 open and the v2 refill.
  The enforcing layer is the wallet at compose time
  (`core/src/sdk/oracleFeePreflight.js`), which hard-refuses an unquotable
  Mode B dispenser.
- **MAX_REFILLS cap .** New rejection: the 6th format-2 edit that
  tops up `GIVE_ESCROW`. Mirrored as a `DISPENSER_MAX_REFILLS` **warning**
  (client cannot see whether the flag-day gate is live for the landing
  block, so an error could false-block a legal refill), counted from
  `getDispenserEdits` with the same `give_escrow > 0` predicate as
  `db.getDispenserRefillCount`.
- **Freshness causality flag-day .** Changes how origin freshness is
  decided (indexer-local chain state instead of the utxo-tracker), not
  whether. Already covered by the existing `DISPENSER_ORIGIN_STANDING`
  unverified; no client change.
- **Expiration-edit divergence counter.** Observability only; no verdict.

`dispense.js`, changes with a client-visible verdict:

- **`FIAT_DISPENSER_PRICING` gate.** New `invalid: FIAT dispenser pricing not
  active` rejection, but the flag is genesis-active on every network, so the
  branch is unreachable in practice. No client change.
- **Multiplier clamp replacing the decrement loop .** Identical by
  construction (the loop's fixed point is `min(multiplier, floor(remaining /
  give_amount))`); a performance fix. No client change.
- **`DISPENSER_CLOSE_PER_UNIT` flag-day .** Auto-close now triggers
  when remaining cannot cover ONE unit rather than the triggering dispense's
  aggregate. The client's `DISPENSER_EMPTY` check already compared against
  the per-unit `give_amount`, so it agrees with the post-flag-day rule.
- **MAX_DISPENSES auto-close .** Emits a real `DISPENSER_CLOSE`, so
  `resolveDispenserState` resolves such a dispenser `closed` off the existing
  close stream regardless of the new `max_dispenses_reached` status string.
  No client change.
- **Validator pair keyed on `GET_COIN`.** Settlement pricing detail; the
  client does not price dispenses. No client change.

Reviewing the refill mechanics also surfaced a pre-existing client defect
that had nothing to do with these diffs: `resolveGiveRemaining` rebuilt
give-remaining as `opening escrow - dispenses`, ignoring refills, which
under-reports a refilled dispenser and raises a false `DISPENSER_EMPTY`
error on a DISPENSE - an action that moves native coin and that Tier 1
cannot cover. It now prefers the explorer's live `state.give_remaining`
(escrow + refills - dispenses) and, on the fallback path, adds refills back
in; when the edit stream is unreachable it reports unverified rather than a
number it knows is low.

### 2026-08-10 - AIRDROP recipient membership became set-backed ()

`src/actions/airdrop.js` changed and the gate correctly demanded a paired
review. The diff converts `recipients` and `approved` from arrays to `Set`s and
switches three `.length` reads to `.size`, because membership was tested with
`Array.indexOf` per recipient on the synchronous per-block path for a list the
indexer's own mapper comments as carrying thousands of addresses.

No verdict the client can see moves, and the reasons are specific rather than
"it is only a refactor":

- Membership resolution here is server-side and already declared unverified,
  the same standing this file records for the  `getList(..., BLOCK_INDEX)`
  change across `dividend.js`, `airdrop.js` and `dispense.js`.
- The counts feeding `AIRDROP_TOTAL_VS_BALANCE` are unchanged. `recipients` is
  reassigned to the deduped `approved` before any length read, so DEBIT and both
  fee branches already saw a deduped count; a `Set` yields the identical count.
- Credit ordering is unchanged, which matters because this is a consensus path.
  A `Set` was chosen over the object-keyed idiom `dividend.js` uses precisely
  because `Set` guarantees insertion order.

Not covered by this entry, and deliberately left alone by the fixing lane: the
same loop still does `recipientAllowList.includes` and `recipientBlockList.includes`
per recipient, the same O(n x m) shape. Registered as . When that lands
it will move this hash again and needs its own line here, but it is the same
argument: server-side membership, already unverified.
