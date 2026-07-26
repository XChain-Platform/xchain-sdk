# Pre-flight ↔ indexer-handler drift map

The Tier-2 client checks in `checks/` mirror validity logic that lives
authoritatively in `xchain-indexer/src/actions/*.js`. When an indexer
handler's validity logic changes, the corresponding client check can
silently drift out of ground-truth, so the drift gate
(`bin/check-preflight-drift.js`, wired into CI) fails when any mapped
indexer handler's SHA-256 changes without a matching update here.

To resolve a drift-gate failure: re-read the changed handler, update the
client check (or confirm no client-visible logic changed), then refresh
the hash below and re-run `node bin/check-preflight-drift.js`.

Ground-truthed against HEAD 2026-07-20; `dispenser.js` and `dispense.js`
re-reviewed against HEAD 2026-07-26 (see the review log below). Hashes
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
| `checks/send.js` (SEND) | `src/actions/send.js` | `a3ec6399d49d37f3f66fc8038a20748d9a2cb5a30f25e82c9017bee1fdf570f8` |
| `checks/send.js` (DESTROY) | `src/actions/destroy.js` | `effe81706519b936fc59a6f3313ee54851830f3fcd5e68fb918e5972df53092a` |
| `checks/mint.js` | `src/actions/mint.js` | `d7f3d36f024c7a654018b1f62ce5a510508a2386ca998c8829d023a5d1ef4de1` |
| `checks/issue.js` | `src/actions/issue.js` | `936fb032d45cac17c51019dc57f4a7c96642c92d9760e471102e41b7fd72294e` |
| `checks/dispenser.js` (open/edit/close) | `src/actions/dispenser.js` | `71d2d477a7eb5a192d260526c684ad825bda9c272b6369f27078fda3f6b5deab` |
| `checks/dispenser.js` (DISPENSE) | `src/actions/dispense.js` | `4db2fe92083e788efa95aa73f7a19658c4a29861d24f73309d69be9f2263625f` |
| `checks/trading.js` (ORDER) | `src/actions/order.js` | `b00096b9f9c8d4cd077d64cd3132ed8ba6754721c736020f73ab3534547f8b33` |
| `checks/trading.js` (SWAP) | `src/actions/swap.js` | `31090210670f290d6cf60f49939bc0f46a526f747bf9dd1354dec1030b3cd80f` |
| `checks/airdrop.js` | `src/actions/airdrop.js` | `e8aa4a881f6c9b9518db75042b6adfc0d52978ff75153ae9e3feba10437444e9` |
| `checks/dividend.js` | `src/actions/dividend.js` | `0a4f60e890b806f33039065927706720c48477e2c39ec538f6eb1126ff4ed64b` |
| `checks/batch.js` | `src/actions/batch.js` | `58269829cb68f5065256544ba134fda0f1dc00491653d25b4b330f1ec035ef64` |

Actions covered by `checks/misc.js` (unverified-only, no client validity
logic) are intentionally NOT mapped: there is nothing to drift from.

## Review log

A hash refresh is only honest if someone actually read the diff. What was
read, and what it changed on the client side, goes here.

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
