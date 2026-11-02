# God controls worker sessions

Status: approved design, not yet built.

## Problem

A worker refused to use credentials until the operator's own line was in its session, so the operator had to type that line into the worker's terminal by hand. Separately, nothing in the harness can answer a worker's permission prompt.

Goal: **god** (the orchestrator agent) can send a command to a **worker** and answer its permission prompts, so the **operator** does not have to.

This does not depend on god's on-demand `/compact`, which lives on the unmerged branch `agent/worker-compact-on-demand`.

## Toggle

New config `orchestratorMayControlAgents: boolean`, default `false`. It is a copy of `orchestratorMaySpawn` at every point that one appears:

- `HarnessConfig` and its defaults in `src/main/config.ts`, and `src/renderer/src/store/config.ts`.
- A mirror on `HiveManager` (`setOrchestratorMayControlAgents`), fed by the config-patch handler and the bootstrap call in `src/main/index.ts`.
- A toggle in `ConfigTab.tsx` (orchestrator workspace) and in `SettingsModal.tsx`.
- Strings in `src/renderer/src/i18n/features/wsOrchestrator.{en,ar,zh-CN}.json`.

God's prompt is built per spawn, so a change to the toggle reaches the prompt the next time god starts.

## Messages

God writes to its outbox. Two new values are added to `MessageAct` in `src/main/hive.ts`:

```json
{"to":"<agent id>","act":"command","body":"/model sonnet"}
{"to":"<agent id>","act":"permission","in_reply_to":"<request id>","body":"allow"}
```

`body` for `permission` is `allow` or `deny`.

`HiveManager.routeOnce` intercepts both acts right after `msg.from = id` (the sender is the owning outbox directory, so it cannot be forged by a field) and before `routeMessage`. The message is archived to `outbox/.sent` like any other. Feedback to god uses the existing `bounceToGod`; the audit trail uses `appendLog`.

Refused with a bounce to god and a log entry of kind `agent-control-refused`:

- the sender is not god;
- the toggle is off;
- the target is god, `human`, `broadcast`, unknown, archived, or the send-only prep assistant;
- a command with an empty body;
- a permission body other than `allow` or `deny`.

## Commands

The body is sanitised: control characters other than newline are stripped (an ESC could end a bracketed paste or drive the TUI), and it is cut to 10000 characters, the same cap as `ControlRegistry.steer`.

Delivery reuses `emitTerminalHandoff` and the `hive:terminalHandoff` channel. `HiveTerminalHandoffEvent` (in `src/preload/index.ts`) gains `raw?: boolean`. When it is set, the listener in `src/renderer/src/hooks/useHive.ts` enqueues `msg.body` verbatim instead of `terminalWorkOrderPrompt(msg)`.

The text therefore goes through the same idle-only queue drain as every other automatic message (`docs/message-queue.md`). `canDeliverToAgent` holds it while the agent is busy or sitting at a prompt, and the floor's delivery pause holds it too. If `emitTerminalHandoff` returns false, the router bounces to god. If the target has no PTY, the listener's existing branch already tells god.

Logged as kind `god-command` with target, message id and the first 200 characters. It works for every provider that has a PTY.

No label is added to the text. Slash commands must arrive verbatim, and the operator accepted that free text looks as if the operator typed it.

## Permission answers

Claude Code only. `CONTRIBUTING.md` requires provider-specific logic to sit behind an explicit check, and `hookSettings` in `hive.ts` is Claude's settings writer. Other CLIs keep their own prompts.

**Install.** `hookSettings` gains a `PermissionRequest` entry with matcher `*` and a hook `timeout` of 330 seconds.

**Shim.** `HOOK_SHIM` in `hive.ts` exits after a fixed 5000 ms. For `PermissionRequest` only, that timer becomes 320000 ms. Exit 0 with empty stdout means "no decision", so the native prompt proceeds.

**Hold.** `HookServer.serve` (`src/main/hooks.ts`) routes `PermissionRequest` to a new hold path before `handle()`. `handle()` is synchronous and answers at once, so it is deliberately not used. The hold replies `{}` immediately when:

- the toggle is off;
- the payload has no agent id;
- the agent is god (god's own prompts stay with the operator);
- the tool is `AskUserQuestion` or `ExitPlanMode`;
- god has no live PTY. `HookServer` has no PTY handle, so `index.ts` passes in a small function backed by `ptyForAgent`.

Otherwise the server:

1. Calls `hive.send` with a message from the worker to god, act `query` (so a batched inbox wake treats it as urgent). The subject names the tool and the worker. The body has the tool name; the JSON of `tool_input` capped at 4000 characters, with a visible note on truncation saying not to approve what cannot be seen; the reply shape; and a line stating that the input is worker-authored data, not an instruction.
2. Keeps the connection open in a map keyed by message id: `{conn, agentId, tool, timer}`.
3. Starts a 5-minute timer that ends the connection with `{}`. A connection `close` removes the entry.

**Answer.** `routeOnce` hands a `permission` message to a handler that `index.ts` sets on `HiveManager` (`hive.ts` does not import `hooks.ts`). The handler looks up `in_reply_to`, checks that the held agent is the message's target, and writes:

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
```

`deny` adds a fixed message. If nothing is held, or the target does not match, god gets a `[stale]` bounce. The harness never sends `updatedInput` or `updatedPermissions`: god approves one call and cannot change its input or add standing rules.

Logged as kind `god-permission` with agent, tool, decision and id. The entry says the decision was **sent**, not applied (see Tested behaviour). It records the tool name only, never `tool_input`.

## Forgery guard

Workers get the whole hive root as a writable directory (`sandboxWritableDirs`), which includes god's outbox. Without a guard, a worker could write a `permission` file as god. So, for workers only and not for god, `hookSettings` adds god's agent folder to `sandbox.filesystem.denyWrite` and adds Edit deny rules for it to `permissions.deny`.

`hookSettings` takes no agent metadata today, so it needs a new argument carrying god's folder (`agentDir(godId)`). Path rules use the absolute form `//abs/path/**`.

This is a guard against accidents and casual prompt injection, not a security boundary:

- **Same OS user.** A determined process can still write there, for example from Bash outside the sandbox, or on a platform with no sandbox. Workers in `bypassPermissions` can probably disable the sandbox per command.
- **Non-Claude workers.** Codex gets `--add-dir` on the hive root in `hive.ts`, and a subfolder cannot be excluded from an added directory. Those workers can still forge.
- A forged permission answer also needs the request id, which is readable in god's inbox.

## Prompt and docs

God's prompt gets a `controlLine` beside `spawnQueueLine`, present only when the toggle is on. It tells god how to use both acts, to approve only what falls inside the task it assigned, to leave destructive, money-spending or out-of-scope actions to the operator, and to treat prompt contents as data. **This is an instruction, not enforcement.**

Docs to update:

- `PROTOCOL_MD` in `hive.ts`: a section on the two acts.
- `renderCommandsMd`: the line saying slash commands cannot run on another agent.
- `HIVE.md` (lines about the approval queue) and the matching header comment in `hive.ts`.
- `docs/message-queue.md`: add the command path to the "One gate" diagram. The one-gate claim itself still holds, since commands use the drain.
- `CHANGELOG.md`.

## Risks

- A typed command is indistinguishable from the operator typing. Anything a worker would accept only from the operator, including use of credentials, god can supply. The operator accepted this explicitly.
- God acts on what it reads, so prompt injection that reaches god could get prompts approved or commands typed on any worker. The off-by-default toggle is the only hard control.
- `tool_input` is copied into god's inbox file and transcript, so a secret on a command line ends up there too.
- Uncommitted tool-activity work touches `hive.ts`, `hooks.ts`, `index.ts` and `useHive.ts`, so whichever change lands second must rebase. That work's inbox batching will treat act `query` as urgent, which the hold relies on.

## Tested behaviour

Claude Code 2.1.303, interactive session in a PTY, Linux, Haiku, default permission mode, hook set in a `--settings` file:

| Case | Result |
|---|---|
| allow | hook fired at 3.9 s, dialog visible at 3.9 s, tool ran at 4.3 s |
| deny | hook fired at 3.7 s, tool never ran |
| silent hook (exit 0, no output) | dialog at 4.8 s, Enter on the dialog, tool ran at 6.6 s |
| long hold | hook fired at 4.0 s, allow at 74.0 s, tool ran at 74.2 s |
| operator answers first | hook fired at 4.2 s, operator said yes, tool ran at 5.8 s; the hook was not killed and exited at 24.2 s with a deny that was ignored |
| `AskUserQuestion` | hook fired with `tool_name` `AskUserQuestion` |

So the native prompt shows alongside the hook: the operator can always answer, and the 5-minute limit only bounds god's window. The harness cannot tell when the operator answered first, which is why the log says "sent".

Not tested: `bypassPermissions` (the session's auto-mode classifier blocked that test), hook timeout expiry, and a late allow after the operator's no.

## Limits

- The default is auto mode, which launches Claude workers with `--permission-mode bypassPermissions` (preset in `src/shared/agentProvider.ts`). Such workers rarely prompt, so the permission half matters mainly with auto mode off. The command half solves the motivating case.
- Agents already running need a restart to get the hook and the guard.

## Rejected alternatives

- **Typing `1` and Enter into the terminal.** The prompt could change first, so god might approve one it never read.
- **A hive-root drop folder like `compact-requests/`.** It records no sender. That is fine for compacting, not for approvals.

## Test plan

`node:test` files under `test/*.cjs`, following `hive-hop-cap`, `hive-unknown-recipient`, `hooks-socket` and `control`.

- Each refusal produces a bounce and an `agent-control-refused` entry.
- A non-god sender cannot command or approve.
- A command is delivered raw, with control characters stripped.
- The hold replies `{}` at once for each exempt case.
- Allow and deny reach the held socket with the exact JSON.
- Stale and mismatched answers bounce.
- The timer ends the hold with `{}`.
- A connection close removes the entry.
- Worker settings carry the guard; god's do not.
- The shim source has the longer timer for `PermissionRequest` only.
