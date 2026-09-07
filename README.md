# OpenCode Goal Orchestration

A source-installed OpenCode plugin that adds durable, verifier-backed Goal
orchestration to the oh-my-opencode-slim specialist workflow.

> [!WARNING]
> **Experimental, source-only GitHub preview.** This is an unofficial full
> replacement fork of
> [`oh-my-opencode-slim` v2.2.17 at commit `7ea8f3e`](https://github.com/alvinunreal/oh-my-opencode-slim/commit/7ea8f3e).
> Goal works only with the OpenCode V1 plugin host. Install this fork instead of
> upstream and never load both at the same time. This project is not endorsed or
> supported by the upstream project.

## Core Capabilities

- A durable Goal for each OpenCode session.
- Automatic Goal creation when the **Goal** primary agent receives its first
  ordinary message.
- Existing OMOS specialist delegation for bounded research and implementation.
- Completion based only on assigned, canonically reconciled verifier evidence.
- Scheduler wake and recovery support for continuing incomplete work.
- Commands to pause, resume, revise, or cancel the current Goal.
- A compact, native, read-only Goal status card in the local OpenCode TUI.
- A localhost-only, read-only browser panel for criteria and progress.

## Prerequisites

- Git
- Bun — validated baseline: **1.4.1**
- OpenCode V1 — tested version: **1.18.29**

Goal runtime observation is not available in the OpenCode V2 plugin host.

## Install from Source

Clone and build this repository:

```bash
git clone https://github.com/userbox020/opencode-goal-orchestration-plugin.git
cd opencode-goal-orchestration-plugin
bun install
bun run build
bun dist/cli/index.js install --no-tui --skills=yes --companion=no --background-subagents=yes
```

The installer registers the checkout path in OpenCode's `plugin` configuration
and creates the plugin configuration with generated model presets. Keep the
checkout in place because OpenCode loads the plugin from that directory.

Close any running OpenCode process and restart it after installation or a
rebuild.

> [!CAUTION]
> `bunx oh-my-opencode-slim@latest` and
> `npx oh-my-opencode-slim@latest` install the upstream npm package. They do not
> install this fork.

### Authenticate and Refresh Models

```bash
opencode auth login
opencode models --refresh
```

Review the generated configuration at:

```text
~/.config/opencode/oh-my-opencode-slim.json
```

### Required Environment Variables

Enable background specialist orchestration with the first variable and Exa web
search with the second:

```text
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
OPENCODE_ENABLE_EXA=1
```

The installer attempts to add these settings to a supported shell startup file.
Open a new terminal afterward. For a one-shot POSIX launch:

```bash
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true OPENCODE_ENABLE_EXA=1 opencode
```

For the current PowerShell session:

```powershell
$env:OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS = "true"
$env:OPENCODE_ENABLE_EXA = "1"
opencode
```

## Quick Start

1. Start OpenCode in your project.
2. Select **Goal** from the primary agent list.
3. Send an ordinary objective.

For example:

```text
Add pagination to the audit log API and verify the existing clients still work.
```

If the session has no Goal, that first message creates one automatically and
opens the Goal panel. Later messages with Goal selected continue the same Goal.

## Goal Commands

| Command | Behavior |
|---------|----------|
| `/goal <objective>` | Create a Goal, or replace a completed or cancelled Goal |
| `/goal status` | Show the current Goal context and progress |
| `/goal panel` | Open the read-only browser panel |
| `/goal pause` | Pause the active Goal |
| `/goal resume` | Resume a paused Goal and audit evidence received while paused |
| `/goal revise <objective>` | Revise an active or paused Goal |
| `/goal clear` | Cancel the current Goal so a new one may be created |

Active, paused, completed, and cancelled Goals are not automatically replaced.
Use `/goal revise` for an active or paused Goal, or `/goal <objective>` after a
Goal becomes terminal.

## How Completion Works

1. Goal interprets the objective and coordinates bounded work through the OMOS
   specialist agents.
2. Completed task results are reconciled into the parent session.
3. Goal assigns a verifier task for each required criterion.
4. A verifier must return the strict verdict marker for that exact assignment.
5. The verdict counts only after the matching task binding is completed and
   canonically reconciled.
6. Goal completes only after every current verification assignment is consumed
   successfully.

There is no manual complete command. A worker saying that a task succeeded, a
completed subtask, or ordinary model prose is not verification proof. Failed,
cancelled, superseded, reused, unassigned, malformed, duplicate, unrelated, or
criterion-mismatched evidence cannot complete a Goal.

See [Goal runtime contract](docs/goal.md) for the detailed evidence and scheduler
rules.

## Persistence and Restart Behavior

Goal state is durable per session. The objective, lifecycle state, criteria,
progress, and accepted completed proof persist across plugin restarts.

Runtime task bindings belong to the current board run. After OpenCode or the
plugin restarts, unfinished bindings and evidence must be observed and
reconciled again before they can count. Previously completed verification proof
remains historical proof, but does not authorize new runtime work.

Paused Goals retain terminal observations for already launched tasks. Evidence
received while paused is audited when the Goal resumes.

## Goal Status Surfaces

In a local OpenCode TUI, the sidebar shows a compact read-only card for the
selected session's Goal, including its lifecycle, verified progress, and
criterion statuses. It refreshes on the TUI's one-second status cycle and has no
controls. Sessions without a readable Goal state show no Goal card.

The native TUI card reads only when OpenCode reports the same state root as the
TUI's local OpenCode data root. Mismatched roots are suppressed and show no Goal
card. Remote attach remains unsupported: OpenCode 1.18.29 exposes no reliable
remote flag, so a remote host reporting an identical path string cannot be
distinguished from the local host. Use the server-side `/goal panel` browser
view when remote state must be authoritative.

### Browser Panel Security

The Goal panel:

- binds to localhost only;
- is read-only and has no state-changing controls;
- displays only current Goal status, criteria, and progress;
- uses an access token held only in plugin memory;
- does not store the token in browser storage or the session transcript.

Run `/goal panel` again after reloading or navigating away from the panel. The
memory-only token is intentionally not reusable through browser storage.

Native Goal cards remain unavailable in OpenCode Web and Desktop. The
localhost-only browser panel remains available through `/goal panel`.

## Updating

Updates are manual. From the existing checkout:

```bash
git pull --ff-only
bun install
bun run build
```

Fully restart OpenCode after rebuilding.

Generated configuration contains `autoUpdate: false`, and the runtime default is
also `false`. Leave auto-update disabled for this source fork.

## Compatibility and Limitations

- Goal is available only in the OpenCode V1 plugin host.
- The tested baseline is Bun **1.4.1** and OpenCode **1.18.29 V1**.
- Public `/goal` creation and revision commands create a generic required
  criterion. There is no public command syntax for supplying a custom criterion
  list.
- This project is source-only and is not published as an npm package.
- The fork must replace upstream `oh-my-opencode-slim`; loading both creates
  conflicting plugin and command registrations.
- Unfinished runtime evidence requires reconciliation again after restart.
- The native Goal card is local-TUI-only. Mismatched data roots show no card;
  identical-path remote hosts cannot be reliably identified.
- Web and Desktop have no native Goal card. The browser panel is read-only and
  is not a Desktop integration.

## Verification Summary

Release-readiness validation for the preview includes:

- TypeScript typechecking.
- **121** targeted release-readiness tests.
- Production build and schema generation.
- Verification of the packed artifact and its advertised entry points.

Release details:
[v0.1.0-preview.0](https://github.com/userbox020/opencode-goal-orchestration-plugin/releases/tag/v0.1.0-preview.0).

## Upstream Attribution and License

This project is an unofficial fork of
[`alvinunreal/oh-my-opencode-slim`](https://github.com/alvinunreal/oh-my-opencode-slim),
based on upstream version **2.2.17**, commit **`7ea8f3e`**. Credit remains with
the upstream authors and contributors for the original orchestration plugin.

Goal integrates with agent registration, task reconciliation, scheduling,
persistence, and plugin lifecycle hooks. That depth of integration requires
this project to be installed as a full replacement fork rather than as a second
plugin beside upstream.

Licensed under the [MIT License](LICENSE).
