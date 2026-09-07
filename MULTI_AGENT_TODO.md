# Multi-Agent Telegram Supervision Roadmap

## Goal

Add an optional multi-agent workflow to the existing Telegram-to-Codex service.
When enabled, a Telegram user can direct work to dynamically configured named
agents, while a coordinator delegates tasks, collects agent results, and
reports observable activity and approval requests back to Telegram. `devBot`
and `qaBot` are examples, not hardcoded roles or required agent names.

The existing single-agent workflow is the compatibility baseline and must not
change unless multi-agent mode is explicitly enabled.

## Feature flag and compatibility contract

Add this environment setting:

```dotenv
MULTI_AGENT=false
```

Also add an optional definitions directory:

```dotenv
MULTI_AGENT_DEFINITIONS_DIR=/home/service-user/.codex/agents
```

The directory contains one editable TOML file per agent. Adding, removing, or
editing files changes the available roles without a source-code change. Use
the service account's `~/.codex/agents/` directory by default because Codex
natively discovers personal custom agents there. For Docker, mount a host
directory at that location instead of baking mutable definitions into the
image.

The feature is enabled **only** when the normalized environment value is
exactly `true`:

- `MULTI_AGENT=true`: enable agent routing, shared multi-agent instructions,
  subagent-aware progress, and multi-agent Telegram commands.
- Missing, empty, invalid, or any value other than `true`: use the current
  single-agent flow unchanged.

Do not create two subtly different versions of the existing execution path.
Keep the current path as the default and add multi-agent behavior at explicit
integration points. Every phase below must include tests proving that
`MULTI_AGENT=false` preserves current behavior.

## Intended interaction

Examples of enabled-mode Telegram messages:

```text
@devBot implement the requested endpoint
@securityBot inspect the authentication boundary
/agent docsBot update the operator guide
/team implement and independently review the endpoint
```

Expected supervision output:

```text
🧑‍💻 devBot: inspecting the affected code paths…
🧑‍💻 devBot: files updated: src/example.ts
🧪 qaBot: running targeted tests…
🧪 qaBot: review complete; one issue found
🤖 coordinator: combined result…
```

The agents are Codex subagents coordinated inside a Codex workflow. They are
not separate Telegram bot accounts and should not impersonate independent
Telegram users.

## Authoritative conversation flow

The Telegram user talks to one orchestrator. The orchestrator owns the task,
selects suitable configured agents, mediates their communication, supervises
their work, and sends the authoritative final response to the user.

```text
Telegram user
      |
      | request, clarification, approval, or cancellation
      v
Orchestrator (main Codex thread)
      |
      | selects agents from the dynamic registry
      | delegates bounded tasks with relevant context
      v
Configured subagents
      |
      | findings, changes, questions, test results, and blockers
      v
Orchestrator
      |
      | relays useful results between agents
      | requests follow-up work and resolves conflicts
      | asks the Telegram user for approvals when required
      v
Telegram user receives one combined final response
```

The orchestrator-mediated flow is the required baseline. The implementation
must not depend on unrestricted direct subagent-to-subagent messaging. If the
Codex runtime supports direct messages, they may be used internally, but all
important decisions, findings, handoffs, and state transitions must remain
visible to the orchestrator so they can be supervised, audited, cancelled, and
summarized correctly.

### Normal task flow

1. The Telegram user sends a task to the orchestrator.
2. The orchestrator reads the current agent registry, the centrally injected
   shared policy, and the selected repository map.
3. The orchestrator decides whether it can handle the task itself or should
   delegate one or more bounded parts.
4. Before delegation, it identifies the selected agents in Telegram when
   useful for supervision.
5. Each subagent performs its assigned work and reports results to the
   orchestrator.
6. The orchestrator passes relevant results to other agents when review,
   clarification, or follow-up work is needed.
7. The orchestrator repeats this loop until the task is complete, blocked,
   rejected, cancelled, or timed out.
8. The orchestrator sends one combined final response containing the outcome,
   changed files, validation results, findings, unresolved risks, and any
   required next steps.

### Example implementation and review loop

```text
User -> Orchestrator:
Implement OAuth login and verify its security.

Orchestrator -> implementation agent:
Implement the scoped OAuth flow and report changed files and tests.

Implementation agent -> Orchestrator:
Implementation complete. Files A and B changed; targeted tests pass.

Orchestrator -> security agent:
Review the completed workspace, focusing on callback validation and token
storage. Do not edit files.

Security agent -> Orchestrator:
State validation is missing and token storage is unsafe.

Orchestrator -> implementation agent:
Address both verified findings and rerun the relevant tests.

Implementation agent -> Orchestrator:
Both findings are fixed; tests pass.

Orchestrator -> verification agent:
Perform final independent verification of the resulting workspace.

Verification agent -> Orchestrator:
Automated checks pass; one manual browser check remains.

Orchestrator -> User:
OAuth login is implemented and reviewed. Summary, files, test results,
remaining manual check, and risks follow.
```

Agent names in this example describe responsibilities only. The actual agents
must be selected dynamically from their editable registry descriptions; the
application must not require agents with these exact names.

### Direct agent request

When the user sends `@agentName <task>` or `/agent <name> <task>`:

1. Telegram still sends the request to the orchestrator.
2. The orchestrator validates the name against its task-start registry
   snapshot.
3. The orchestrator delegates the task to that agent with the relevant context
   and constraints.
4. The selected agent reports to the orchestrator, not directly as an
   independent Telegram account.
5. The orchestrator returns the agent's result, adding coordination,
   validation, approval, or safety context when necessary.

An agent mention is a routing request, not permission to bypass the
orchestrator, sandbox, repository allowlist, approval policy, or shared
instructions.

### Multi-repository feature request

One user-visible task may span multiple related repositories. For example, a
user may bind a frontend and backend repository and ask for one coordinated
feature:

```text
BE=/srv/projects/user-api FE=/srv/projects/user-web

Create a user flow. Required fields: first name, last name, and email.
Optional fields: phone and address.
```

The orchestrator must treat this as one product task with multiple repository
scopes:

1. Resolve `BE` and `FE` to canonical administrator-allowlisted repositories.
2. Reject arbitrary paths, path traversal, symlink escapes, duplicate aliases,
   or repositories the Telegram user is not authorized to use.
3. Read the applicable instructions and relevant code from both repositories.
4. Define the shared contract first: request/response schema, validation,
   optional-field behavior, errors, and compatibility expectations.
5. Delegate backend work with the `BE` scope and frontend work with the `FE`
   scope to suitable configured agents. The same agent may handle both scopes
   sequentially, or different agents may work concurrently when their writes
   cannot conflict.
6. Pass contract changes and discoveries through the orchestrator so frontend
   and backend implementations stay aligned.
7. Delegate cross-repository verification or review after implementation.
8. Return one final response grouped by repository, including changed files,
   tests, contract decisions, integration risks, and remaining manual checks.

Example coordination:

```text
User -> Orchestrator:
Use BE=/srv/projects/user-api and FE=/srv/projects/user-web. Create the user
flow with required firstName, lastName, and email; phone and address optional.

Orchestrator -> backend-capable agent:
In BE only, implement the agreed create-user API and validation. Report the
contract and changed files.

Orchestrator -> frontend-capable agent:
In FE only, implement the form and API integration against the agreed
contract. Do not invent fields or endpoints; return integration assumptions.

Backend agent -> Orchestrator:
Endpoint, validation behavior, response shape, and tests are complete.

Orchestrator -> Frontend agent:
Confirm the implementation matches this final backend contract and adjust any
verified mismatch.

Orchestrator -> review agent:
Review the end-to-end flow across both repository scopes and run the available
checks without editing unless explicitly permitted.

Orchestrator -> User:
Combined backend/frontend outcome, validation rules, files, tests, and risks.
```

Absolute paths in a Telegram message are references, not new access grants.
They are accepted only if their canonical paths exactly match configured and
authorized repository entries. The preferred everyday syntax should use stable
repository keys, for example `BE=api FE=web`, so filesystem paths do not need
to be exposed in chat.

### Questions and communication between agents

- Subagents return questions and blockers to the orchestrator.
- The orchestrator answers from established task context when safe.
- If user judgment, new authority, or an important requirement is missing, the
  orchestrator asks the Telegram user rather than guessing.
- The orchestrator relays only relevant context between agents and preserves
  attribution so agents can evaluate prior findings.
- Agents may disagree. The orchestrator must request evidence or another
  focused check, resolve the conflict when possible, and disclose unresolved
  disagreement in the final response.
- Subagent messages may appear in Telegram as labelled progress for
  supervision, but they are not authoritative final responses.

### Approval flow

1. A subagent reaches an action requiring approval.
2. The request flows through the orchestrator and application to Telegram.
3. Telegram shows the selected repository, requesting agent when reliably
   known, action summary, working directory, and reason.
4. The user approves once, approves for the session, rejects, or cancels.
5. The decision is returned to the requesting workflow and recorded safely.
6. The orchestrator reports the effect of rejection or cancellation to any
   dependent agents and adjusts the plan.

No subagent may approve another subagent's action or broaden its own authority.

### Cancellation, failure, and timeout flow

- Cancelling the orchestrator task cancels its complete subagent tree.
- A task timeout applies to coordination, all delegated work, approvals, and
  follow-up loops as one overall task.
- A failed subagent reports failure to the orchestrator. The orchestrator may
  retry safely, choose another configured agent, continue without that result,
  or stop and report the blocker.
- The orchestrator must not report successful completion while required
  subagent work is still running or failed without resolution.
- The final Telegram response must clearly distinguish completed, partially
  completed, failed, rejected, cancelled, and timed-out outcomes.

### Communication ownership rules

- The Telegram user normally communicates only with the orchestrator.
- The orchestrator owns task state, delegation, sequencing, and the final
  response.
- Subagents own only their explicitly delegated work.
- Subagents communicate results through the orchestrator-controlled workflow.
- Only the orchestrator sends the authoritative final answer to Telegram.
- Progress messages must identify their agent when attribution is verified.
- Important handoffs and decisions must be auditable without storing raw chain
  of thought, unbounded logs, secrets, or unnecessary internal reasoning.

## Proposed ownership of instructions

Use three instruction layers with distinct responsibilities:

1. **Service-owned shared policy**
   - Store a canonical multi-agent policy in this repository, for example
     `config/multi-agent-instructions.md`.
   - Load and inject it into Codex `developerInstructions` only when
     `MULTI_AGENT=true`.
   - Include role boundaries, delegation protocol, repository isolation,
     approval rules, secret-handling rules, and the required final report.
2. **Dynamic custom-agent definitions**
   - Read all valid `*.toml` definitions from
     `MULTI_AGENT_DEFINITIONS_DIR` (default: service account
     `~/.codex/agents/`).
   - Treat every file as administrator-controlled configuration. The `name`,
     `description`, and `developer_instructions` fields define the available
     role and its responsibilities.
   - Do not hardcode `devBot`, `qaBot`, or any other role in application code.
   - Use the same directory Codex natively loads so the Telegram registry and
     Codex runtime cannot drift into two different lists of agents.
   - Support a documented reload mechanism so an administrator can add, remove,
     or change responsibilities without rebuilding the application.
3. **Centrally injected identity and policy**
   - Workable repositories are not required to contain `AGENTS.md`, `.codex`,
     custom-agent files, or other files owned by this Telegram service.
   - The service injects the orchestrator policy into every enabled Codex
     thread through `developerInstructions`.
   - Codex loads each dynamic subagent's identity and responsibilities from the
     centrally managed TOML registry.
   - Agents inspect the selected repository's code, scripts, manifests, and
     documentation to learn project-specific commands and conventions.
   - If administrators need repository-specific guidance that is not stored in
     the workable repository, support optional centrally managed repository
     profiles, for example `config/repositories/<repository-key>.md`, and inject
     the matching profile into tasks scoped to that repository.
   - Never create, overwrite, or require instruction files inside workable
     repositories as part of enabling multi-agent mode.

The service already starts Codex App Server with the selected repository as
its working directory. Preserve that behavior for filesystem context, command
execution, and current single-repository compatibility; do not rely on that
repository containing service-owned agent identities.

Example editable registry:

```text
/home/service-user/.codex/agents/
├── developer.toml
├── quality-reviewer.toml
├── security-reviewer.toml
└── documentation.toml
```

Example definition:

```toml
name = "securityBot"
description = "Use for authentication, authorization, secret handling, and security reviews."
sandbox_mode = "read-only"
developer_instructions = """
Review security-sensitive behavior and report evidence with file references.
Prioritize access control, injection risks, credential exposure, unsafe command
execution, and trust-boundary mistakes.
Do not edit files. Return findings to the coordinator, including severity,
impact, and a practical remediation.
"""
```

An administrator can change this agent's responsibilities by editing
`developer_instructions`, change when the coordinator selects it by editing
`description`, or remove the role by removing its TOML file and safely
reloading the registry.

## Phase 1: Configuration and feature gating

- [ ] Add `readonly multiAgent: boolean` to `AgentConfigService`.
- [ ] Parse `MULTI_AGENT` with the existing strict boolean helper so only
      `true` enables it.
- [ ] Add `MULTI_AGENT=false` to `.env.example`.
- [ ] Document the flag and its default in `README.md`.
- [ ] Add configuration tests for `true`, `false`, missing, empty, and invalid
      values.
- [ ] Confirm startup does not require agent files when the flag is disabled.
- [ ] Fail startup with a clear, non-secret error when enabled mode requires a
      configured instruction or agent file that is missing or invalid.

Acceptance criteria:

- With the flag absent or false, existing configuration tests and application
  startup behavior remain unchanged.
- With the flag true, the service exposes a typed enabled-mode configuration
  without changing repository selection or sandbox configuration.

## Phase 2: Shared instruction loading

- [ ] Add a small service responsible for loading the canonical shared
      multi-agent policy.
- [ ] Resolve its path safely from application configuration; do not resolve it
      relative to whichever target repository is selected.
- [ ] Set a reasonable maximum file size and reject unreadable or empty policy
      files when enabled.
- [ ] Combine instructions in this order:
      1. service-owned multi-agent policy when enabled;
      2. existing secret-file policy;
      3. any narrowly scoped per-turn routing instruction.
- [ ] Keep only the existing secret-file policy when disabled.
- [ ] Ensure instructions are supplied consistently to both `thread/start` and
      `thread/resume`.
- [ ] Add tests that inspect App Server requests and verify the exact enabled
      and disabled instruction behavior without exposing secrets.

Acceptance criteria:

- Every enabled-mode thread receives the same service-owned collaboration and
  safety rules regardless of the selected repository.
- Disabled mode sends the same developer instructions as the current release.

## Phase 3: Dynamic custom-agent registry

- [ ] Add `MULTI_AGENT_DEFINITIONS_DIR`, defaulting to the service account's
      `~/.codex/agents/` directory.
- [ ] Build an `AgentRegistryService` that discovers `*.toml` files in that
      directory and returns immutable typed snapshots to active tasks.
- [ ] Require each definition to contain `name`, `description`, and
      `developer_instructions`, matching the Codex custom-agent schema.
- [ ] Allow supported optional Codex settings such as `model`,
      `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, and
      `skills.config`, but reject unknown or unsafe application-specific
      extensions unless they are explicitly designed and tested.
- [ ] Derive Telegram help text, mention routing, `/agents`, and coordinator
      role descriptions from the registry.
- [ ] Do not encode role responsibilities in TypeScript. An administrator must
      be able to change an agent's responsibilities by editing its TOML file.
- [ ] Validate names, descriptions, instructions, file sizes, duplicate names,
      unsupported values, and unsafe paths.
- [ ] Reserve coordinator and built-in application identifiers so custom files
      cannot impersonate system messages.
- [ ] Decide and document reload semantics. Recommended initial behavior:
  - load and validate at startup;
  - provide an administrator-only `/reloadagents` command;
  - atomically replace the registry only if every definition is valid;
  - let active tasks keep their starting snapshot;
  - apply the new snapshot only to subsequent tasks.
- [ ] If automatic file watching is added later, debounce events and retain the
      last valid snapshot when a file is partially written or invalid.
- [ ] Ship `devBot` and `qaBot` only as editable example definitions. Operators
      may rename, remove, or replace them with roles such as `securityBot`,
      `docsBot`, `databaseBot`, or `researchBot`.
- [ ] Do not hardcode a model in examples initially; inherit the
      administrator-selected model unless model selection becomes a documented
      requirement.
- [ ] Configure an appropriate maximum number of concurrent subagent threads.
- [ ] Document native and Docker directory ownership, permissions, mounts, and
      reload behavior.

Acceptance criteria:

- An enabled Codex session can explicitly delegate to every valid agent in the
  current registry snapshot.
- Adding or removing a valid TOML file changes `/agents` and future routing
  after a documented reload, without a code change.
- Agent definitions are identical across configured repositories because they
  come from one service-account registry.

## Phase 4: Telegram routing

- [ ] Add a parser that recognizes any registered agent mention only at the
      beginning of a message, such as `@devBot ...` or `@securityBot ...`.
- [ ] Treat agent names case-insensitively for input while mapping them to one
      canonical configured name.
- [ ] Avoid confusing Telegram's own `@BotUsername` command suffix syntax with
      custom-agent mentions.
- [ ] Add generic commands as a reliable alternative:
  - `/agent <name> <task>`
  - `/team <task>`
  - `/agents`
- [ ] Optionally generate convenient aliases from configuration, but do not
      hardcode `/dev`, `/qa`, or other role-specific commands.
- [ ] Convert routing into a structured internal request rather than relying
      only on prompt wording.
- [ ] Have the prompt adapter produce a bounded delegation instruction naming
      the requested custom agent and preserving the user's text verbatim as
      task content.
- [ ] Reject unknown agents with a list of available agents.
- [ ] When disabled, do not register multi-agent commands and forward ordinary
      `@devBot` text through the current single-agent path unchanged.
- [ ] Add parser and Telegram-handler tests, including malformed, empty,
      oversized, and command-suffix inputs.

Acceptance criteria:

- Enabled-mode routing is deterministic and does not depend on the model
  guessing what an `@name` means.
- Disabled mode continues forwarding non-command Telegram text exactly as it
  does today.

## Phase 5: Coordinator workflows

- [ ] Define the coordinator contract for direct-agent and team requests.
- [ ] For a direct request, instruct the main agent to delegate the bounded task
      to the selected agent and return that agent's result.
- [ ] For `/team`, let the coordinator select suitable agents from their
      registry descriptions and instructions, then present or announce the
      selected roles before work begins.
- [ ] When a task needs implementation followed by independent review, use a
      sequential workflow even if the selected roles have names other than
      `devBot` and `qaBot`.
- [ ] Do not let any agents edit overlapping files concurrently.
- [ ] Permit parallel agents only for independent, read-heavy work.
- [ ] Keep the task's approved repository scope fixed for the full turn. In a
      normal task this is one selected repository; in an explicitly bound
      multi-repository task it is the validated set of aliases. Agents must not
      move into any other allowlisted repository merely because it exists in
      configuration.
- [ ] Ensure cancellation of the parent task interrupts or terminates its
      active subagents.
- [ ] Ensure task timeout applies to the entire coordinated workflow.

Acceptance criteria:

- Agent-to-agent collaboration happens through the coordinator and Codex
  subagent facilities, with one authoritative final response.
- Existing one-active-task-per-chat behavior remains intact unless a separate
  concurrency feature is deliberately designed later.

## Phase 5A: Multi-repository workspace scopes

- [ ] Extend configuration with administrator-defined workspace groups, for
      example:

```dotenv
MULTI_REPOSITORY_WORKSPACES_JSON={"user-flow":{"BE":"api","FE":"web"}}
```

      Values refer to keys already present in `REPOSITORIES_JSON`; do not make
      this a second unrestricted path allowlist.
- [ ] Add a typed workspace scope containing an alias, repository key,
      canonical path, and authorization metadata for each member.
- [ ] Add `/workspace <name>` and `/scope` commands to select and display a
      configured group.
- [ ] Optionally parse leading bindings such as `BE=api FE=web`. If absolute
      paths are accepted for compatibility with the user's proposed syntax,
      require exact canonical matches to already allowlisted and authorized
      repository paths.
- [ ] Preserve the existing `/repo <name>` single-repository selection flow.
- [ ] Ignore or reject multi-repository syntax with a clear message when
      `MULTI_AGENT` is disabled; do not silently broaden the legacy sandbox.
- [ ] Change the App Server workspace-write sandbox only for a validated
      multi-repository task so `writableRoots` contains exactly its approved
      repository paths.
- [ ] Choose and document a stable primary `cwd` for the coordinator while
      passing an explicit alias-to-canonical-path map in its instructions.
- [ ] Before delegating work in a repository, inject the shared orchestrator
      policy, the selected agent identity, the repository alias scope, and
      any centrally configured repository profile. Do not require an
      `AGENTS.md` inside the workable repository.
- [ ] Require agents to inspect the repository's existing manifests, scripts,
      code, tests, and ordinary documentation before choosing implementation or
      validation commands.
- [ ] Give every delegated task an explicit allowed alias/path and state
      whether it may read, write, test, or only review that repository.
- [ ] Require shared API/data contracts to be recorded by the orchestrator and
      included in dependent agents' task context.
- [ ] Track progress, approvals, changed files, and results with both agent and
      repository alias attribution.
- [ ] Prevent simultaneous writers to the same repository unless a later
      conflict-safe worktree design explicitly supports it.
- [ ] Apply parent cancellation and timeout to all repository-scoped work.
- [ ] Add tests for canonicalization, authorization, duplicate aliases,
      symlinks, unavailable repositories, mixed read/write scopes, and sandbox
      root construction.

Acceptance criteria:

- One Telegram task can safely coordinate a feature across two or more
  explicitly scoped allowlisted repositories.
- Agents can create and modify relevant files in both `FE` and `BE` when the
  task scope, sandbox, and approval policy permit it.
- No Telegram-provided alias or path can expand access beyond administrator
  configuration and per-user authorization.
- Repository-specific instructions and test commands are applied to the work
  performed in each repository.
- The final response and audit trail clearly attribute changes and checks to
  the correct repository.

## Phase 6: App Server protocol discovery and progress events

- [ ] Record the installed Codex/App Server version in diagnostics.
- [ ] Inspect the current App Server protocol schema for subagent lifecycle,
      thread, collaboration, and agent-message notifications.
- [ ] Extend test fixtures with representative subagent events from the actual
      installed protocol. Do not invent event names based only on assumptions.
- [ ] Introduce a typed progress event instead of passing only a string:

```ts
interface ProgressEvent {
  kind: 'command' | 'file-change' | 'agent-status' | 'agent-message';
  agentName?: string;
  agentThreadId?: string;
  message: string;
}
```

- [ ] Parse supported subagent start, progress, completion, failure, and
      interruption events.
- [ ] Preserve current command and file-change progress behavior.
- [ ] Gracefully ignore unknown notifications while logging safe diagnostic
      metadata at debug level.
- [ ] Never forward raw protocol payloads, tool output, secrets, or unbounded
      logs to Telegram.
- [ ] If the protocol does not expose granular subagent messages, show only
      lifecycle events and coordinator-provided summaries.

Acceptance criteria:

- Telegram can label observable activity with a verified agent identity.
- Unsupported protocol events do not fail an otherwise valid turn.
- Disabled mode produces the current generic progress messages.

## Phase 7: Telegram supervision experience

- [ ] Format enabled-mode progress with stable role labels and compact status
      text.
- [ ] Include the requesting agent's name on approval messages when the
      protocol provides trustworthy attribution.
- [ ] Add `/teamstatus` showing the selected repository, coordinator status,
      active agents, elapsed time, and most recent safe status per agent.
- [ ] Keep `/status` backward compatible.
- [ ] Make the existing cancel button cancel the complete coordinator workflow.
- [ ] Rate-limit and deduplicate agent progress independently so one noisy
      agent cannot hide another's updates.
- [ ] Preserve Telegram message-length limits and Markdown safety.
- [ ] Clearly label the final message as the coordinator's combined result.

Acceptance criteria:

- A supervisor can tell which agent is active, what broad action it is taking,
  whether approval is required, and how the overall task ended.
- Telegram remains responsive while an approval or subagent result is pending.

## Phase 8: Persistence and auditability

- [ ] Add a migration mechanism before changing the SQLite schema.
- [ ] Store task execution mode (`single` or `multi`) in task audit records.
- [ ] Store the requested agent or workflow type.
- [ ] Add a subagent activity table only if it provides operational value;
      avoid storing every token or raw message.
- [ ] Associate approvals with agent identity when available.
- [ ] Store safe summaries, timestamps, statuses, parent task ID, and Codex
      thread IDs needed for troubleshooting.
- [ ] Apply existing truncation and future redaction rules to all new fields.
- [ ] Decide how resumed threads behave if `MULTI_AGENT` changes between runs;
      safest initial behavior is to start a fresh thread when the execution
      mode changes.

Acceptance criteria:

- Audits can distinguish single-agent from multi-agent tasks.
- Restart and thread-resume behavior cannot silently mix incompatible modes.

## Phase 9: Security review

- [ ] Verify subagents cannot expand the selected repository's writable roots.
- [ ] Reapply parent sandbox and approval policy to every subagent workflow.
- [ ] Confirm target repository paths still come only from the application
      allowlist.
- [ ] Do not accept arbitrary custom agent file paths or agent definitions from
      Telegram users. Only administrators with filesystem access may edit the
      configured definitions directory.
- [ ] Require Telegram approval for the same sensitive actions regardless of
      which agent requested them.
- [ ] Include agent identity, selected repository, command, working directory,
      and reason in approval summaries when safely available.
- [ ] Review prompt-injection risks from repository files that try to override
      service-level safety or redirect agents into another repository.
- [ ] Confirm secret-file instructions apply to the coordinator and all
      subagents.
- [ ] Test symlink and path-boundary behavior for workspace writes.

Acceptance criteria:

- Enabling multiple agents does not broaden repository access, network access,
  approval authority, or secret access.
- The Telegram user remains the authority for actions that currently require
  approval.

## Phase 10: Test matrix

- [ ] Unit tests:
  - strict `MULTI_AGENT` parsing;
  - instruction composition;
  - mention and command routing;
  - unknown-agent rejection;
  - enabled/disabled progress formatting;
  - audit mode persistence.
- [ ] App Server integration tests:
  - single-agent fixture remains unchanged;
  - direct delegation to multiple dynamically named agents;
  - sequential implementation-to-review workflow using configured roles;
  - adding, editing, removing, and reloading agent definitions;
  - invalid reload retaining the last valid registry snapshot;
  - attributed approval request;
  - subagent failure and coordinator recovery;
  - parent cancellation with active subagents;
  - unknown notification compatibility.
- [ ] Telegram handler tests:
  - `/agents`, `/agent`, `/team`, `/teamstatus`, and administrator-only
    `/reloadagents`;
  - leading mentions;
  - authorization and callback ownership;
  - progress throttling across multiple agents;
  - disabled-mode behavior.
- [ ] Regression commands:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

- [ ] Run the complete suite once with `MULTI_AGENT=false` and once with
      `MULTI_AGENT=true`.

## Phase 11: Documentation and rollout

- [ ] Update `.env.example` and the README configuration table.
- [ ] Document custom-agent file locations and precedence.
- [ ] Document native and Docker setup.
- [ ] Add Telegram command examples and explain that agents are Codex
      subagents, not Telegram accounts.
- [ ] Document token/cost implications of parallel subagent work.
- [ ] Add troubleshooting for missing agents, unsupported protocol events,
      approvals, timeouts, and stale resumed threads.
- [ ] Roll out initially with `MULTI_AGENT=false`.
- [ ] Enable it in a non-production installation and one test repository.
- [ ] Exercise implementation, review, approval, cancellation, timeout, and
      restart scenarios.
- [ ] Enable additional repositories only after reviewing their scripts,
      configuration, permissions, and sandbox expectations.

## Definition of done

The feature is complete only when all of the following are true:

- `MULTI_AGENT=true` enables deterministic named-agent delegation and team
  workflows.
- Available agents and their responsibilities come from editable TOML files,
  not hardcoded application roles.
- Adding, removing, or editing agent definitions takes effect through the
  documented safe reload process without rebuilding the service.
- `MULTI_AGENT=false`, missing, or invalid preserves the current single-agent
  behavior.
- Shared service instructions apply consistently across all selected
  repositories.
- Workable repositories do not require service-owned `AGENTS.md` or `.codex`
  files; agent identity and policy are injected centrally.
- Optional repository-specific profiles are centrally managed and selected by
  allowlisted repository key.
- Telegram exposes verified agent lifecycle information and approvals without
  leaking raw protocol data or secrets.
- Parent cancellation and timeout cover the entire subagent workflow.
- Repository allowlisting, sandboxing, network settings, and approval policy
  are no weaker in multi-agent mode.
- Tests cover both execution modes and all supported Telegram routing forms.
- README setup, security guidance, and operational limitations are current.

## Suggested first implementation slice

Keep the first pull request intentionally small:

1. Add strict `MULTI_AGENT` configuration with a default of `false`.
2. Add and test shared instruction loading/composition.
3. Add the dynamic registry and two editable example definitions (`devBot` and
   `qaBot`).
4. Add `/agents`, `/agent <name>`, and dynamic leading-mention routing.
5. Delegate through the coordinator but keep existing generic progress output.
6. Verify disabled-mode regression tests.

Add granular subagent event display, team status, and audit-schema changes only
after capturing and testing the actual App Server notifications produced by the
installed Codex version.
