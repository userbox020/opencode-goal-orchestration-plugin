# Goal (V1 only)

Select **Goal** from the primary agent list when you want the active Goal to
drive execution. It can inspect the project, coordinate bounded specialist
work, reconcile task results, and verify the required criteria.

For local OpenCode TUI sessions, the native sidebar shows a compact, read-only
Goal card with the objective, lifecycle, verified progress, and criterion
statuses. It refreshes on the TUI's one-second render cycle and has no controls.
Sessions without a readable Goal state show no card. The card requires the TUI
and plugin server to report the same OpenCode state root; mismatched roots are
suppressed and show no Goal card. Remote attach is unsupported because OpenCode
1.18.29 exposes no reliable remote flag. A remote host reporting an identical
path string cannot be distinguished from the local host, so use the server-side
`/goal panel` browser view when remote state must be authoritative.

OpenCode Web and Desktop do not have native Goal cards. The plugin does not
create, update, or show a Desktop status card.

The first ordinary message you send with **Goal** selected automatically creates
a durable orchestration goal if this session has no Goal. Existing active,
paused, completed, and cancelled Goals are never automatically replaced.
Use `/goal <objective>` to create a Goal or replace a terminal Goal; use
`/goal revise <objective>` to change an active or paused one. The command also
supports `/goal status`, `/goal panel`, `/goal pause`, `/goal resume`,
`/goal revise <objective>`, and `/goal clear`.

`/goal panel` opens a plugin-owned, localhost-only, read-only browser panel in
the default browser. It shows only the current Goal status, criteria, and
progress; it has no controls and cannot mutate Goal state. This is not an
embedded Desktop status card and requires no OpenCode source modification. Goal
creation does not open a browser; run `/goal panel` explicitly. Reloading the
page also requires `/goal panel`: its access token is intentionally kept in
memory, not in browser storage or the session transcript.

Goal runtime observation is available only in the V1 plugin host. V2 exposes
no Goal command or partial runtime behavior. Runtime task bindings are scoped
to the current board run; after a plugin restart, unfinished work must be
observed and reconciled again. Completed Goals retain their historical
verification proof and progress without authorizing new runtime work.

While a Goal can continue, its wake uses the V1 shared orchestrator wake
scheduler; paused or reconciliation-waiting Goals suppress legacy TODO and
stopped-job wake prompts. Goal completion records only explicitly assigned,
canonical reconciled verification evidence and never infers success from model
or task prose.

Goal-owned verifier tasks use the exact description
`Goal verification: <criterion-id>` and must return one strict
`<goal_verdict>` JSON marker. The runtime assigns that task to the named
criterion and consumes only a matching structured verdict after canonical task
reconciliation. Ordinary task descriptions and prose results remain
non-authoritative. Terminal observations for already-launched tasks continue to
be persisted while a Goal is paused.

Completion waits for all current verification assignments to be consumed.
Evidence received while paused is audited on resume only within the same board
run. Transient live persistence failures retain pending reconciliation for
retry instead of silently discarding the verdict.

Before board-run rehydration, V1 makes one completion-only recovery attempt for
an active Goal. Every current pending verifier assignment must have exactly one
completed current binding, unique exact parent launch provenance, the exact
child session, and a terminal error-free final assistant result containing one
strict matching passing verdict. One atomic update must consume the entire
batch and complete the Goal. Paused, partial, invalid, or inconclusive batches
write no recovered evidence; normal re-fencing retires them and requires fresh
verification.

The scheduler rehydrates Goal state before its first post-restart fallback
decision. A pending binding reconciliation receives one Goal-owned scheduler
wake; terminal Goals release normal fallback scheduling.

Completed subtasks are not objective proof. Runtime evidence is accepted only
for the exact current completed-and-reconciled binding of a persisted Goal
verification assignment. Failed, cancelled, superseded, reused, unassigned,
and unrelated bindings cannot complete a Goal. Malformed, duplicate, or
criterion-mismatched verdict markers fail closed and leave the Goal incomplete.

## Verification

`bun run build` produces the artifacts used by the package checks.
`bun run verify:host-smoke` checks visible Goal registration and its execution
prompt against a pinned OpenCode 1.18.29 host. `OMOS_HOST_SMOKE_VERSION` can
select a separate compatibility target; it does not change the default baseline.

`bun run verify:goal-workflow` uses the same packed artifact and real host with
a local scripted model. It exercises automatic creation, native worker and
verifier tasks, and a completed authenticated panel snapshot. Only the browser
launcher is replaced by a fixture callback. It uses no external model account
and is not evidence of a particular model's reasoning quality.

`bun run verify:release` checks advertised files and clean-install root, server,
and TUI imports. Restart OpenCode to load a rebuilt plugin.
