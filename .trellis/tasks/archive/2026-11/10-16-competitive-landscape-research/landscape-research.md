# ZeroWork Competitive Landscape — Feature Research

Research date: 2026. All claims below were verified against vendor documentation fetched directly (URLs cited inline).
Where a page was unreachable from this host, that is stated explicitly rather than guessed.

ZeroWork's existing feature list (from the task brief) is treated as off-limits: multi-scenario chat,
Experts + skills, MCP connectors, document parsing, scheduled tasks, session management (archive/fork/stats),
audit log, three-tier permissions + sandbox, command palette, multi-model compare, Projects, Library,
file history/time machine, resume deck, subagents + teams, turn trace, pinning/export/themes, memory.js,
prompt templates.

---

## 1. Cursor

- **Plan Mode** — agent researches the codebase, asks clarifying questions, produces an editable plan document, then you click to build. Plans save to home dir or "Save to workspace" for reuse/team sharing. Shift+Tab rotates modes. (https://cursor.com/docs/agent/plan-mode)
- **Hooks** — spawned processes speaking JSON over stdio at ~30 lifecycle points (preToolUse, beforeShellExecution, beforeMCPExecution, sessionStart/End, subagentStart/Stop, preCompact, workspaceOpen…). Third-party hooks (Claude Code format) can be loaded. Cloud agents run repo-command hooks only. (https://cursor.com/docs/hooks)
- **Four rule types** — Project Rules (`.cursor/rules/*.mdc`, version-controlled, with `alwaysApply` / `globs` / `description` / manual-@-mention attachment modes), User Rules, Team Rules, and `AGENTS.md`. A plain `.md` in `.cursor/rules` is IGNORED — no frontmatter means no rules semantics. (https://cursor.com/docs/rules)
- **Agent Review** — dedicated code review of local changes, reads `BUGBOT.md` rules, auto-runs after each task/commit; two depths (Quick / Deep); can compare ALL local changes against main, "not only the latest edit". (https://cursor.com/docs/agent/agent-review)
- **Canvases** — agent-authored interactive artifacts (sections, stats, tables, charts) rendered beside chat; saved, reopenable, re-runnable with fresh data; publishable as a live snapshot link. Packaged in a skill as trigger description + layout + data sources + formatting rules. (https://cursor.com/docs/agent/tools/canvas)
- **Worktrees + Agents Window** — isolated git checkouts per agent, set up via `.cursor/worktrees.json` with `setup-worktree-windows` / `setup-worktree-unix` / `setup-worktree` (command array or script path), `$ROOT_WORKTREE_PATH` to copy `.env`. Docs explicitly warn against symlinking dependencies. Agents Window adds multi-workspace parallel agents, a new diffs view, and cloud↔local handoff. (https://cursor.com/docs/configuration/worktrees, https://cursor.com/docs/agent/agents-window)
- **Other**: non-blocking clarifying questions (agent keeps working while you answer), image generation into `assets/`, checkpoint restore (files only, not messages), queued vs steering messages, browser tool with logs-to-files grep strategy and per-workspace persistent cookies. (https://cursor.com/docs/agent/overview, /tools/browser)

## 2. Windsurf / Cascade (now merged into Devin — docs at docs.devin.ai)

> Note: `docs.windsurf.com/windsurf/*` cross-origin redirects to `docs.devin.ai`; Windsurf was absorbed into Devin.

- **Memory + Dreaming** — preferences, corrections, project lessons saved as notes carried across sessions; "Dreaming" keeps notes organized. (https://docs.devin.ai/product-guides/memory)
- **Previews** — preview the web app locally in the IDE or browser with element selection and error capture, wired directly into the agent loop for iteration. (https://docs.devin.ai/desktop/previews)
- **Agent Command Center + Spaces** — manage many agents from one surface; Spaces group work. (https://docs.devin.ai/desktop/agent-command-center, /desktop/spaces)
- **Devin Local** — a local agent (`/desktop/devin-local`) that runs on your machine alongside cloud delegation; ACP (Agent Client Protocol) support for custom agents. (https://docs.devin.ai/desktop/acp, /desktop/acp-custom)
- **Skills as committed `SKILL.md`** — testing/deploy/review procedures committed to the repo so they run identically every session. (https://docs.devin.ai/product-guides/skills)
- **Codemaps / DeepWiki / AI Commit Messages / Quick Review / Fusion** — auxiliary surfaces for code understanding and review. (https://docs.devin.ai/desktop/codemaps, /desktop/deepwiki, /desktop/ai-commit-message, /desktop/quick-review, /desktop/fusion)

## 3. Claude Desktop / Claude Code

- **Hooks** — shell commands at ~35 lifecycle events, four types (`command`, `prompt`, `agent`, `http`). `PreToolUse` can BLOCK and fires before any permission-mode check, so a deny hook cannot be bypassed by switching modes. `Prompt`-type hooks can feed a reason back so Claude keeps working; `agent`-type hooks spawn a subagent to verify a condition against the real codebase. (https://code.claude.com/docs/en/hooks-guide.md)
- **Skills** — `SKILL.md` with progressive disclosure ("body loads only when it's used, so long reference material costs almost nothing until you need it"). Custom slash commands MERGED into skills. Dynamic context injection: a line like `` !`git diff HEAD` `` is executed and inlined before Claude sees the skill. `context: fork` runs a skill in an isolated subagent. `/skill-doctor` reports per-skill context cost and flags never-invoked skills. (https://code.claude.com/docs/en/skills.md)
- **Two memory systems** — (1) `CLAUDE.md` hierarchy (managed policy > user > project > local), all CONCATENATED root→cwd, `@path` imports depth-4, `.claude/rules/*.md` with `paths:` globs loading only when a matching file is touched; (2) AUTO MEMORY in `~/.claude/projects/<project>/memory/` with a `MEMORY.md` index + typed topic files (`user` / `feedback` / `project` / `reference`), first 200 lines or 25KB of the index loaded every session. (https://code.claude.com/docs/en/memory.md)
- **Checkpointing + `/rewind`** — every prompt that starts a turn creates a checkpoint; 100 most recent per session; `/rewind` offers Restore code+conversation / Restore conversation / Restore code / Summarize from here / Summarize up to here. Documented limits: Bash-made changes untracked, subagent edits usually not restored, symlinked/hardlinked paths skipped. (https://code.claude.com/docs/en/checkpointing.md)
- **Worktrees with hard isolation** — `.claude/worktrees/<name>`, `.worktreeinclude` copies gitignored files (.env) in, `worktree.baseRef` fresh|head, subagent frontmatter `isolation: worktree`. Isolation is ENFORCED: blocks Edit/Write into the main checkout, blocks Bash whose cwd can't be verified outside it, blocks git redirects, and blocks commands whose text can't be parsed to prove git stays inside. (https://code.claude.com/docs/en/worktrees.md)
- **Output Styles** — markdown + frontmatter setting role/tone/format for EVERY response: Default, Proactive, Concise, Explanatory, Learning (leaves `TODO(human)` pieces and waits). Docs draw the feature boundary crisply: CLAUDE.md = what Claude should KNOW; output style = how it RESPONDS every time; skill = instructions for ONE task, on demand; hook = something that happens EVERY time. (https://code.claude.com/docs/en/output-styles.md)
- **Sandboxing + `failIfUnavailable`** — OS-enforced (Seatbelt / bubblewrap). Reads allow most of the machine INCLUDING `~/.ssh` and `~/.aws/credentials` unless denied; network starts with an EMPTY allowedDomains list. Critically for ZeroWork's identity: *"By default, if the sandbox can't start … Claude Code runs commands without sandboxing. To make Claude Code exit at startup instead, set `sandbox.failIfUnavailable` to true."* There is also an unsandboxed-retry escape hatch (`dangerouslyDisableSandbox`) that strict mode disables. (https://code.claude.com/docs/en/sandboxing.md)
- **Status line + subagent status line** — any shell script fed session JSON on stdin: cost, context-window used %, cache hit ratio and miss causes, rate limits with reset times, PR state, worktree, vim mode. `subagentStatusLine` renders each subagent row with token samples. (https://code.claude.com/docs/en/statusline.md)

## 4. OpenAI Codex / ChatGPT desktop

> `developers.openai.com`, `platform.openai.com`, `github.com`, and `raw.githubusercontent.com` are ALL blocked from this host (403 "This request was blocked" / "Forbidden"). Findings below are from the Wikipedia article, which cites primary sources.
> Note: OpenAI is not a standard on-premises vendor and is not competing for the local-first slot. The feature lessons, however, are portable.

- **Cloud task environments** — each task runs in a separate cloud environment preloaded with the repo; the agent reads/edits files, runs tests, invokes code-checking tools; tasks take 1–30 min and return command logs + test results for inspection. Initially no general internet access for security; later optional. (https://en.wikipedia.org/wiki/OpenAI_Codex_(AI_agent))
- **Unified "App Server" architecture** — one server powers the CLI, VS Code extension, web app, macOS desktop app, and third-party IDE integrations (JetBrains, Xcode); "keeps long-running sessions and approval requests consistent across client interfaces". (ibid.)
- **Windows-native agent sandbox** — Windows release added native PowerShell support plus a sandbox built from OS controls: restricted tokens and filesystem ACLs. (ibid.)
- **Desktop app for managing multiple agents** — Feb 2026 desktop app "intended to help users manage multiple coding agents over longer periods and use code to gather or analyze information". (ibid.)
- **Enterprise plugin bundles** — organizations package workflows, app integrations, and MCP server configs into installable bundles managed by policy via private marketplaces. (ibid.)
- **`AGENTS.md`** as the cross-tool convention (also read by Codex, Cursor, Warp, Devin, Zed, Copilot).

## 5. VS Code Copilot Agent mode

> `code.visualstudio.com` docs are reachable; append `.md` for markdown.

- **Custom agents / chat modes** — `.github/agents/*.agent.md` (or `.chatmode.md`); each defines a persona with its own tool list, model, and instructions, selectable from the chat mode dropdown. (https://code.visualstudio.com/docs/copilot/customization/custom-agents)
- **Instruction file matrix** — `.github/copilot-instructions.md` (repo-wide, always on) plus `.instructions.md` files with `applyTo:` frontmatter globs applied only to matching files, plus `AGENTS.md` support. (https://code.visualstudio.com/docs/copilot/customization/custom-instructions)
- **Agent Skills** — implements the same open `SKILL.md` standard as Claude Code, with progressive disclosure and slash invocation. (https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- **Subagents / delegation** — the agent can delegate to other agents and tools, with results flowing back into the main thread.
- **Checkpoints & change review** — per-turn checkpoints plus a review surface for the accumulated diff of a session. (https://code.visualstudio.com/docs/copilot/chat/chat-checkpoints)
- **Plan mode + customization marketplace** — plan-before-build mode and a marketplace for sharing agents/instructions/skills.

## 6. Local-first AI agents

### Jan
> jan.ai and www.jan.ai are unreachable from this host (connection failure on every attempt). Coverage below is limited to what is corroborated elsewhere; treat as the weakest section of this report.

- Jan is the leading open-source, fully offline ChatGPT-alternative desktop app (Electron/Node + llama.cpp), notable for: local GGUF model management via a Cortex backend, an OpenAI-compatible local server, an assistant/model-hub architecture, and a **MCP-capable extensions** system.

### LM Studio (https://lmstudio.ai/llms.txt, /docs/app/*)
- **Chat with Documents with automatic RAG-vs-full-context decision** — attaches `.docx`, `.pdf`, `.txt`; *"If the document is short enough (i.e., if the document fits in the model's context), LM Studio will add the file contents to the conversation in full… If the document is very long, LM Studio will opt into using Retrieval Augmented Generation"*. (https://lmstudio.ai/docs/app/basics)
- **Presets / Config Presets + Prompt Library** — saved parameter sets per model, plus a reusable prompt library. (ibid.)
- **Per-model defaults & prompt-template override** — per-model default inference and load parameters, and per-model prompt template editing. (https://lmstudio.ai/docs/app/advanced)
- **Idle TTL and Auto-Evict** — per-model or app-default TTL so models unload from memory after inactivity; JIT model loading for OpenAI endpoints. (https://lmstudio.ai/docs/app/api)
- **User / Power User / Developer UI modes** — progressive disclosure of interface complexity. (https://lmstudio.ai/docs/app/user-interface)
- **`lms` CLI + headless server** — `lms load/unload/ls/ps`, `lms server start`, `lms log stream` to debug prompts, plus remote operation against another machine. (https://lmstudio.ai/docs/cli)

### Msty Studio (https://docs.msty.ai/studio/*)
- **Branch Explorer** — conversation tree navigation with branching.
- **Chunks visualizer** — inspect exactly which document chunks were retrieved and injected (RAG transparency).
- **Toolsets** — grouped tool configurations.
- **Agent Mode + Skills Studio** — agents and a workshop to edit skill metadata and `SKILL.md`.
- **Local + online model mix** and strong privacy posture.

### AnythingLLM (https://anythingllm.com/)
> `docs.anythingllm.com` is behind a Cloudflare JS challenge from this host; homepage marketing plus blog posts used instead.
- **Document Knowledge** — every document becomes part of the agent's knowledge base with no data leaving the device.
- **Background Jobs** — recurring automated tasks.
- **Meeting Assistant** — listens locally (no bot joins the call), transcribes and summarizes with speaker labels and action items.
- **Custom Agent Skills + custom tool builder + developer API**.
- **Dynamic model selection** and web scraping/search built in.
- **Mobile companion** — the same agent on-device, pairing with desktop to reach larger models and full workspaces.

### Cherry Studio (https://docs.cherry-ai.com)
- Claude-Code-style agent workspace with a **5-level permission mode** ladder, memory, artifacts preview, and a broad provider matrix. Chinese-market local-first desktop app.

### Chatbox (https://docs.chatboxai.app)
- Multi-model chat with **file understanding** (PDF/Word/Excel/images), **Claude-Artifacts-like live code preview**, web search mode, chart generation with LaTeX rendering, local-first storage, and an MCP section in the docs.

### Open WebUI (https://docs.openwebui.com/features/)
- Self-hosted ChatGPT-style platform: **Workspaces** (Models / Knowledge / Prompts / Tools), **Knowledge collections with per-collection RAG tuning**, **Pipelines + Functions + Tools plugins**, **Channels** (team chat), **Notes**, **Calendar**, per-user model access control and RBAC, **valves** (per-user config for a function), and multi-user auth. Evaluation/arena leaderboard features for comparing models.

## 7. Devin, OpenHands, Aider, Continue.dev

### Devin
Covered above (Memory + Dreaming, Previews, Agent Command Center, Spaces, ACP, Skills).

### OpenHands (https://docs.openhands.dev — append `.md`)
- **Keyword-Triggered Skills** — `SKILL.md` frontmatter `triggers: [github, git]` loads the skill ONLY when a prompt contains one of those words. (https://docs.openhands.dev/overview/skills/keyword.md)
- **Path-Triggered Rules** — injected deterministically whenever the agent reads/edits/creates a file matching a glob; the doc states they "behave like Claude Code 'rules' — guaranteed to load for the files they scope, **with no reliance on the model choosing them**". (https://docs.openhands.dev/overview/skills/path.md)
- **Context Condenser** — `LLMSummarizingCondenser` summarizes older turns when history exceeds a threshold while keeping recent messages intact and preserving user goals / technical specs / critical files. (https://docs.openhands.dev/sdk/guides/context-condenser.md)
- **Persistent Memory, two tiers** — User `~/.openhands/memory/` and Project `<workspace>/.openhands/memory/`, each with a curated `MEMORY.md` index (the ONLY file injected) plus `YYYY-MM-DD.md` daily logs the agent reads on demand. Plain Markdown, so a team can commit `.openhands/memory/`. Injected inside an `<UNTRUSTED_CONTENT>` wrapper. (https://docs.openhands.dev/sdk/guides/persistent-memory.md)
- **Critic (experimental)** — an extra evaluation pass predicting success likelihood with issue labels; the agent can auto-refine after a low score. (https://docs.openhands.dev/openhands/usage/agent-canvas/critic.md)
- **Plugins** — bundle skills + hooks + MCP servers + agents + commands into reusable packages.
- **Automations with Git sync** — browse/export/import/enable/disable/run automations from a UI view, and back them up / share them through a Git repository. (https://docs.openhands.dev/openhands/usage/agent-canvas/git-sync.md)

### Aider (https://aider.chat/docs)
- **Repo map** — a ranked, token-budgeted map of the whole repo (via tree-sitter symbol extraction + graph ranking) that gives the model architectural awareness without reading every file. This is the single most-copied Aider feature.
- **Chat modes** — `code` / `ask` / `architect` / `help`; architect mode splits a reasoning model that proposes from an editor model that applies, which measurably improves edit quality.
- **AI comments / watch files** — run with `--watch-files` and aider watches the repo for AI coding instructions you add as comments in source, then acts on them.
- **Git-native by default** — auto-commits each successful change with a generated message, `/undo` to revert the last AI commit, and attribution trailers.
- **Voice-to-code**, lint/test auto-fix loop, and `/add` `/drop` explicit context curation.

### Continue.dev (https://docs.continue.dev)
- **Model roles** — assign a different model per function (chat vs autocomplete vs edit vs apply vs embed vs rerank), with a wide provider matrix including fully self-hosted.
- **Plan mode** — "a safe, read-only environment to explore your codebase, map out solutions, and collaborate with AI before making any changes… The core principle is *understand before you change*"; cycle modes with `Cmd/Ctrl + .`. (https://docs.continue.dev/guides/plan-mode-guide)
- **Rules** — `.continue/rules` (version-controlled, project-specific) plus global rules. (https://docs.continue.dev/customize/rules)
- **Tool policies** — per-tool allow/ask/exclude policy so safe tools run automatically and risky ones prompt. (https://docs.continue.dev/ide-extensions/agent/quick-start)
- **Custom slash commands / prompt templates** and **MCP tools**.
- **Instinct** — an open 7B Next Edit model you can run locally via Ollama. (https://docs.continue.dev/guides/instinct)

## 8. Raycast AI, Warp, Zed AI

### Raycast AI (https://manual.raycast.com/ai)
- **Screen Awareness** — press a hotkey (default: double-tap right ⌘/Ctrl) and Raycast captures the focused window: *"the app's content, the text you have selected, and a screenshot"*, gathered independently so a capture still works when parts are unavailable. (https://manual.raycast.com/ai/screen-awareness)
- **AI Agents (formerly Presets)** — save role + model + `Instructions` system prompt + the exact list of AI Extensions + reasoning effort; "Only the extensions you add here are available to it, which scopes the Agent to just the AI Extensions its task needs". Model can be locked per agent. (https://manual.raycast.com/ai/agents)
- **Projects** — group related chats with shared **instructions**, **a memory built from the conversations inside**, and a **working directory for file and terminal work**. (https://manual.raycast.com/ai/projects)
- **Skills** — `SKILL.md` files discovered from the *"default folders used by common AI agents"* (i.e. reads other tools' skill dirs), auto-loaded when relevant, toggleable per chat. (https://manual.raycast.com/ai/skills)
- **AI Extensions** — installed Raycast extensions expose their commands as tools the AI can call; `@browser`, `@calendar`, `@calculator` etc. (https://manual.raycast.com/ai/ai-extensions)
- **Automations** — run an AI prompt on a schedule (Once / Hourly / Daily) into a new or existing chat, able to use Extensions, MCP servers and Skills; creatable in plain language. (https://manual.raycast.com/ai/automations)
- **Local Models via Ollama** — detected automatically and added to the model picker; *"Requests to local models go straight from Raycast to the Ollama server on your machine."* (https://manual.raycast.com/ai/local-models)

### Warp (https://docs.warp.dev)
- **Agent Profiles with per-action autonomy** — Apply code diffs / Read files / Create plans / Execute commands / Interact with running commands / **Ask clarifying questions**, each set to Agent Decides | Always ask | Always allow | Never. Plus a **command allowlist and denylist** where *the denylist takes precedence over the allowlist and over "Always allow"* — except "Run until completion" bypasses it by default, with a setting to prevent that, and team-enforced denylist rules are never bypassed. (https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/)
- **Agent planning with plan version history** — `/plan` produces a plan in a rich text editor with clickable file paths; *"Any update made by the agent creates a new version"*; version history lets you compare and restore; plans persist in Warp Drive and are reusable across sessions via `@plans`; you can execute only a specific phase. (https://docs.warp.dev/agents/capabilities/planning/)
- **Interactive Code Review** — leave inline comments on specific lines/blocks of the agent's diff, batch them, and submit all feedback in one pass; "instead of relying on an AI to review another AI's output, Warp keeps the developer in control". (https://docs.warp.dev/agents/local-agents/interactive-code-review/)
- **Full Terminal Use** — the agent attaches to the live PTY of an interactive app (psql, gdb, vim, python REPL, dev server), sees the live buffer, writes to it, and control can be handed back and forth with Takeover / Hand back. Prompts queue while the agent drives a command it started. (https://docs.warp.dev/agents/capabilities/full-terminal-use/)
- **Computer Use with annotated video evidence** — cloud sandbox only; records sessions with idle/thinking gaps cut and action overlay pills burned in; the video is attached to the PR as proof. (https://docs.warp.dev/agents/capabilities/computer-use/)
- **Upfront context approval with denial + retry** — before anything runs, Warp lists exactly which files will be read, what's excluded by .gitignore, and where writes will land; deny it and the agent adjusts. (https://docs.warp.dev/agents/capabilities/codebase-context/)
- **Agent Task Lists** and **Rules/`/init`** — auto-generated step list with per-step status; `/init` can link `CLAUDE.md`, `.cursorrules`, `AGENT.md`, `GEMINI.md`, `.clinerules`, `.windsurfrules`, `.github/copilot-instructions.md` into `AGENTS.md`. (https://docs.warp.dev/agents/capabilities/task-lists/, /rules/)
- **Local-to-cloud handoff with uncommitted changes** — `/handoff` carries the conversation history *and a snapshot of your uncommitted changes*; `/continue-locally` forks a cloud conversation back down. (https://docs.warp.dev/agents/capabilities/slash-commands/)

### Zed AI (https://zed.dev/docs/ai/*.md)
- **Tool Permissions with regex patterns** — per-tool `always_allow` / `always_confirm` / deny regex lists, e.g. auto-approve `^cargo\s+(build|test|check)` and `^npm\s+(install|test|run)` while always confirming `sudo\s+/`. Deny rules are blocked *even when the default is "allow"*. (https://zed.dev/docs/ai/tool-permissions)
- **OS-level agent sandboxing** — Seatbelt / bubblewrap / Windows; applies to the `terminal` and `fetch` tools; explicitly documented as complementary to tool permissions ("Tool permissions restrict the agent's ability to run certain tool actions in the first place; once a tool action is actually running, sandboxing restricts what it can do"), and honest about Windows being weaker. (https://zed.dev/docs/ai/sandboxing)
- **Threads Sidebar / Parallel Agents** — many concurrent threads across projects, each with its own context window, grouped by project, with archive → Thread History → restore, and **worktree isolation** to stop two threads fighting over the same files. (https://zed.dev/docs/ai/parallel-agents)
- **New From Summary** — start a fresh thread seeded with a summary of the current conversation when approaching the context limit. (https://zed.dev/docs/ai/agent-panel)
- **Steering vs queuing** — messages sent mid-generation queue by default; toggling "Steer" interrupts the agent at its next step instead. (ibid.)
- **Agent Profiles, Skills (with a `create-skill` skill), Instructions, Follow-the-agent, prevent idle sleep, notifications** — and checkpoints with a "Restore Checkpoint" button at the top of each message, shown even if you interrupted mid-edit. (ibid., /docs/ai/skills, /docs/ai/instructions)

---

# GAP ANALYSIS

Twelve candidates that ZeroWork does NOT already have, ranked by weighted score.
Scoring: each dimension 1–5. Weighting reflects that a local-first, auditable office agent
must weight Feasibility and Identity-fit heavily — a feature that cannot run without a server
scores near zero on this product regardless of how beloved it is elsewhere.

**Weights:** (a) User value ×1.0 · (b) Feasibility ×1.5 · (c) Differentiation ×1.0 · (d) Identity fit ×1.5

| # | Feature | a | b | c | d | Weighted |
|---|---|---|---|---|---|---|
| 1 | Plan Mode with persistent, reviewable plan artifacts | 5 | 5 | 4 | 5 | 24.0 |
| 2 | Deterministic hooks (lifecycle event scripts) | 4 | 5 | 5 | 5 | 24.0 |
| 3 | Interactive diff review with batched inline comments | 5 | 4 | 4 | 5 | 22.5 |
| 4 | Path-scoped + keyword-triggered rule injection | 5 | 5 | 3 | 5 | 23.0 |
| 5 | Context Condenser (summarize, keep a restorable original) | 5 | 4 | 3 | 5 | 21.5 |
| 6 | Scoped agent profiles (role + model + tool subset) | 4 | 5 | 4 | 4 | 21.5 |
| 7 | Per-tool regex permission policies (allow/confirm/deny) | 5 | 5 | 3 | 5 | 23.0 |
| 8 | Screen Awareness (capture focused window + selection) | 5 | 4 | 5 | 4 | 22.0 |
| 9 | Annotated evidence capture as a first-class artifact | 3 | 3 | 5 | 4 | 18.5 |
| 10 | Session/task worktree isolation for parallel agents | 3 | 5 | 3 | 4 | 19.5 |
| 11 | Output styles (session-wide response shaping) | 3 | 5 | 3 | 4 | 19.5 |
| 12 | "New from summary" + thread-history archive/restore | 4 | 5 | 2 | 4 | 19.5 |

---

## 1. Plan Mode with persistent, reviewable plan artifacts

**One-line:** A read-only research phase that produces an editable, versioned plan document the user
approves before any file is touched — and the plan survives as a reusable, `@`-referenceable artifact.

**Have it:** Cursor (https://cursor.com/docs/agent/plan-mode), Continue (https://docs.continue.dev/guides/plan-mode-guide),
Warp (`/plan` + version history, https://docs.warp.dev/agents/capabilities/planning/),
VS Code Copilot plan mode, Claude Code (plan mode).

**Why it matters:** Office work is disproportionately "change these twelve documents consistently,"
where a wrong first move costs more than in code. Every product that shipped plan mode converged on
the same two mechanics — *edit the plan before execution* and *re-run from a refined plan rather than
patching a confused agent* — and Warp's addition of **plan version history** ("any update made by the
agent creates a new version") is the piece that makes plans trustworthy rather than decorative.
ZeroWork already has turn-trace and file time machine, so the plan artifact is the one missing link
between "what the agent intends" and "what the agent did."

**Implementation sketch:**
- `src/main/daemon/plan.js` — new module. Plan store at `<workspace>/.zerowork/plans/<id>/plan.md` +
  `versions/<n>.md`, mirroring the existing file-history versioning code so plan edits get the same
  reversible treatment. Emits `plan.created` / `plan.revised` / `plan.approved` audit events.
- `src/main/daemon/agent-loop.js` — a `plan` mode where the tool registry is filtered to read-only
  tools (read/grep/glob), and `write`/`exec` are absent rather than merely denied, so the "refuse
  rather than silently degrade" principle holds structurally.
- `src/renderer/src/plan-panel.js` — a plan editor surface with a version picker and an "Implement
  phase N" action; the plan is a markdown file so the existing editor and export paths reuse.
- IPC: `plan:create`, `plan:get`, `plan:save`, `plan:approve`, `plan:list`, `plan:diff`.
- Reuse: the resume-deck card for a job can link its plan; `@plan:<id>` becomes a context provider
  alongside existing `@`-mentions.

---

## 2. Deterministic hooks (lifecycle event scripts)

**One-line:** User-authored scripts that run at fixed lifecycle points — guaranteed to fire, unlike
instructions the model may choose to follow.

**Have it:** Claude Code (~35 events, four hook types, https://code.claude.com/docs/en/hooks-guide.md),
Cursor (~30 events over stdio JSON, https://cursor.com/docs/hooks), OpenHands plugins bundle hooks.

**Why it matters:** Claude Code's own framing is the argument: hooks give *"deterministic control:
certain actions always happen rather than relying on the LLM to choose to run them."* For an
**auditable office agent** this is the difference between "we asked the model not to email
unredacted data" and "a `PreToolUse` hook blocks it, and the block is in the audit log." ZeroWork
already has the audit log and the permission ladder — hooks are what let a *user* extend that
boundary without shipping a new build. Two details are worth copying exactly: `PreToolUse` fires
**before** any permission-mode check so a deny hook cannot be bypassed by loosening the mode, and an
`agent`-type hook can spawn a subagent to verify a condition against real filesystem state before
letting a turn end.

**Implementation sketch:**
- `src/main/daemon/hooks.js` — hook registry, matcher resolution, and a child-process runner with
  per-event timeouts. Reads `hooks` from the existing settings store plus `.zerowork/hooks.json`.
- Events that matter for this product: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (blocking),
  `PostToolUse`, `PreFileWrite`, `PostFileWrite`, `Stop`, `SessionEnd`, `PreCompact`, `TaskCreated`.
  `PreToolUse` must be wired into the sandbox/permission gate, not beside it.
- `src/main/daemon/permissions.js` — call the hook gate before the tier check; a deny is final and
  writes an `audit/hook-blocked` entry.
- `src/renderer/src/settings-hooks.js` — a browser/editor for hooks with a test-run button that
  shows the JSON payload and the exit code.
- IPC: `hooks:list`, `hooks:save`, `hooks:test`, `hooks:event` (streamed to the trace view).
- Identity win: because the sandbox already refuses on unsupported platforms, a hook that fails to
  launch must **fail the tool call**, never silently skip.

---

## 3. Interactive diff review with batched inline comments

**One-line:** Review the agent's accumulated diff, attach comments to specific lines, and submit the
whole batch in one pass so the agent revises once instead of once per nitpick.

**Have it:** Warp Interactive Code Review (https://docs.warp.dev/agents/local-agents/interactive-code-review/),
Cursor agent review (https://cursor.com/docs/agent/agent-review), VS Code Copilot change review,
Devin Quick Review.

**Why it matters:** Warp's stated design goal is the one that fits ZeroWork: *"Instead of relying on
an AI to review another AI's output, Warp keeps the developer in control."* ZeroWork already has file
history and turn traces, so the diff data exists — what's missing is the **annotation channel**.
Batching is the load-bearing part: a per-comment round trip multiplies model spend and produces
thrash, while one batched submission converges in a single revision. Cursor's second review entry
point (compare ALL local changes against main, "not only the latest edit") catches the
cross-file inconsistency that per-turn review misses — for office work that is exactly the
"you updated the spreadsheet but not the memo" class of error.

**Implementation sketch:**
- `src/main/daemon/review.js` — builds a review session from the file-history store: a set of
  changed paths with before/after blobs, plus comments keyed `{path, side, lineStart, lineEnd, body}`.
  Persist to `<workspace>/.zerowork/reviews/<id>.json` so a review survives restart and is auditable.
- `src/renderer/src/diff-review.js` — line-annotatable diff view reusing the existing
  `code-preview.js` renderer; a comment list with submit-batch.
- `src/main/daemon/agent-loop.js` — a `review.submit` entry point that injects the batch as a single
  structured user turn (path + line range + comment), so one revision pass results.
- IPC: `review:open`, `review:comment`, `review:submit`, `review:discard`.
- Reuse: the same before/after blobs that power time-machine restore; review submission is itself a
  logged audit event since it authorizes file mutation.

---

## 4. Path-scoped and keyword-triggered rule injection

**One-line:** Project instruction files that load **only** when the agent touches a matching file
(glob) or when the prompt contains a trigger keyword — instead of one giant always-on preamble.

**Have it:** Claude Code `.claude/rules/*.md` with `paths:` frontmatter and on-demand subdirectory
`CLAUDE.md` (https://code.claude.com/docs/en/memory.md); OpenHands Path-Triggered Rules and
Keyword-Triggered Skills (https://docs.openhands.dev/overview/skills/path.md, /skills/keyword.md);
Cursor project rules with `globs`/`description` (https://cursor.com/docs/rules); VS Code
`.instructions.md` `applyTo:`; Warp `AGENTS.md` scoped per directory with documented precedence
(current subdirectory > root > global, https://docs.warp.dev/agents/capabilities/rules/).

**Why it matters:** ZeroWork's audience is office work, where one workspace routinely holds
contracts, spreadsheets, decks, and code — each with different conventions. A single always-on
instruction blob either bloats every turn or gets ignored. OpenHands states the guarantee that makes
this more than an optimization: path rules are *"guaranteed to load for the files they scope, with no
reliance on the model choosing them"* — that is a determinism property, which is exactly the
ZeroWork house style. Cursor's frontmatter matrix is also worth copying wholesale because it has
clean, teachable semantics (`alwaysApply:true` → always; globs only → auto-attach on match;
description only → model pulls it in; neither → only when @-mentioned).

**Implementation sketch:**
- `src/main/daemon/rules.js` — discovers `.zerowork/rules/*.md` plus `AGENTS.md` at repo root and in
  ancestor directories; parses `paths:` globs, `triggers:` keywords, and a `precedence` field.
- `src/main/daemon/agent-loop.js` — hook into the tool-call path: when a `read`/`write`/`edit` targets
  a path, inject matching rules for that turn; on `UserPromptSubmit`, inject keyword-triggered rules.
  Both injections render in the existing turn-trace view as "context derived from rule X" so the
  user can see *why* the agent behaved a certain way (Warp surfaces this as "References").
- `src/main/daemon/memory.js` — extend the existing memory module rather than adding a parallel
  system; rules and memory are both "durable guidance," and two mechanisms that drift is the failure
  mode to avoid.
- IPC: `rules:list`, `rules:resolve` (given a path or prompt, show what would load — a debuggability
  affordance the existing product style demands), `rules:save`.
- Import path: on first run in a workspace, offer to import `CLAUDE.md`, `.cursorrules`,
  `.windsurfrules`, `.github/copilot-instructions.md` (Warp's `/init` link list is the model).

---

## 5. Context Condenser that preserves a restorable original

**One-line:** When a conversation outgrows the model's window, summarize the old turns into a
compact digest while keeping recent turns verbatim — and keep the pre-compression transcript
recoverable.

**Have it:** OpenHands `LLMSummarizingCondenser` (https://docs.openhands.dev/sdk/guides/context-condenser.md),
Claude Code `/compact` + PreCompact/PostCompact hooks + `/rewind`'s "Summarize from here / up to here"
(https://code.claude.com/docs/en/checkpointing.md), Warp `/compact` and `/fork-and-compact`
(https://docs.warp.dev/agents/capabilities/slash-commands/), Zed "New From Summary"
(https://zed.dev/docs/ai/agent-panel).

**Why it matters:** This is the most universally-shipped feature in the survey, and it is the one
ZeroWork is most likely to lose users over. Office sessions are long — a contract review runs for
hours — and the failure is user-visible: the agent forgets the constraint established forty turns
ago. OpenHands' specification of *what to preserve* is the useful part: keep recent messages intact,
preserve user goals / technical specifications / critical files, summarize the rest. Claude Code
adds the two moves that make it safe: summarize **from a chosen point** (not only the whole
history), and have `SessionEnd`/`PreCompact` hooks fire so a user can flush state to disk before
it is compressed away.

**Implementation sketch:**
- `src/main/daemon/condenser.js` — token accounting against the active model's window plus a
  configurable trigger threshold; on trigger, call the model with the old span and a
  preservation-oriented prompt (goals, constraints, file paths, decisions).
- `src/main/daemon/session-store.js` — write `<session>/compact/<n>.jsonl` containing the FULL
  original turns before replacing them in the live context, and record the summary's id. The
  existing session-fork machinery then makes "decompress" nearly free: forking from a pre-compaction
  message already restores the unsummarized history.
- `src/renderer/src/trace-view.js` — render a compaction marker inline in the timeline, expandable to
  the original text, so the condensation is visible rather than silent. This is the same
  anti-silent-degradation instinct as logging `audit/cleared`.
- IPC: `session:compact`, `session:compactPreview` (show the digest before committing), `session:uncompact`.
- Should be **user-visible and confirmable by default** for office users; auto-compact is the
  behavior that erodes trust.

---

## 6. Scoped agent profiles (role + model + tool subset)

**One-line:** Named, saved configurations binding a role/instructions + a specific model + an explicit
allow-list of tools, selectable per conversation.

**Have it:** Raycast AI Agents (https://manual.raycast.com/ai/agents), Warp Agent Profiles
(https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/), Zed Agent Profiles
(https://zed.dev/docs/ai/agent-profiles), VS Code custom agents
(https://code.visualstudio.com/docs/copilot/customization/custom-agents).

**Why it matters:** Raycast's phrasing captures the mechanism that makes this more than a preset
list: *"Only the extensions you add here are available to it, which scopes the Agent to just the AI
Extensions its task needs."* That is **capability reduction by construction** rather than by
instruction — a contract-review profile that literally lacks the shell tool cannot be talked into
running a command. ZeroWork ships Experts + skills, which is the *knowledge* half; a profile is the
*capability* half, and for an auditable product the second half is what a security reviewer will ask
about. Warp's per-action autonomy ladder (Apply code diffs / Read files / Create plans / Execute
commands / Ask clarifying questions, each Agent-Decides|Always-ask|Always-allow|Never) maps almost
one-to-one onto ZeroWork's existing three-tier permission model and is a natural extension of it.

**Implementation sketch:**
- `src/main/daemon/profiles.js` — profile store at `~/.zerowork/profiles/<id>.json` (user-scoped) with
  optional `<workspace>/.zerowork/profiles/` for project-scoped ones. Fields: `name`, `icon`,
  `instructions`, `model` (or `inherit`), `tools[]`, `mcpServers[]`, per-action autonomy overrides.
- `src/main/daemon/agent-loop.js` — resolve the active profile at session start and construct the
  tool registry from its `tools[]` list. Tools not in the list are **absent**, not denied — a
  distinction worth preserving because an absent tool cannot be hallucinated back into existence.
- `src/main/daemon/permissions.js` — profile autonomy overrides layer on top of the three-tier
  default, with the existing rule that looser settings can never widen a stricter tier.
- `src/renderer/src/profile-picker.js` — selector in the composer; profile editor in settings.
- IPC: `profiles:list`, `profiles:get`, `profiles:save`, `profiles:setActive`.
- Synergy: profiles reference existing Experts/skills rather than duplicating them; a profile is the
  container, the Expert is the content.

---

## 7. Per-tool regex permission policies

**One-line:** Allow / always-confirm / deny rules expressed as regexes over the tool's arguments,
evaluated before execution and with deny rules that cannot be overridden.

**Have it:** Zed `agent.tool_permissions` (https://zed.dev/docs/ai/tool-permissions), Warp command
allowlist/denylist (https://docs.warp.dev/agents/capabilities/agent-profiles-permissions/),
Claude Code permission rules with the `if` field using `Bash(git *)` syntax
(https://code.claude.com/docs/en/hooks-guide.md), Continue tool policies
(https://docs.continue.dev/ide-extensions/agent/quick-start).

**Why it matters:** ZeroWork's three-tier model is a *coarse* gate; the complaints that generate
feature requests are all fine-grained — "I'm tired of approving `git status` forty times" and "I want
`rm -rf` to always prompt even in the permissive tier." Zed's example is the exact shape of the fix:
auto-approve `^cargo\s+(build|test|check)` and `^npm\s+(install|test|run)`, always confirm `sudo\s+/`.
The precedence rule is the security-critical part and both vendors state it identically — the
denylist wins over the allowlist and over "always allow" — and Zed adds the further guarantee that
deny rules "blocked even when default is set to allow". Warp's honesty about the escape hatch is
worth imitating too: it documents that "Run until completion" bypasses the denylist by default, ships
a setting to stop that, and states that team-enforced rules are never bypassed. ZeroWork writing
down its own equivalent and making it configurable is more trustworthy than a silent bypass.

**Implementation sketch:**
- `src/main/daemon/permissions.js` — add a policy layer with ordered rule evaluation: `deny[]` →
  `always_confirm[]` → `allow[]` → tier default. Rules are `{pattern, flags?, tool, note}`.
- Match against the same normalized tool-argument strings already captured for the audit log, so
  the audit entry can record *which rule matched* — a genuinely differentiating audit property.
- `src/renderer/src/settings-permissions.js` — rule editor with a live tester box: paste a command,
  see which rule fires and why. Same debuggability standard as the rules-resolution view above.
- IPC: `permissions:listRules`, `permissions:testRule`, `permissions:saveRules`.
- Test surface: this is pure logic on strings — cheap to unit test exhaustively, and it should be,
  because a regex precedence bug is a security bug.

---

## 8. Screen Awareness (capture the focused window, its text, and the selection)

**One-line:** One hotkey captures what you are looking at — app name, readable window text, your
text selection, and a screenshot — and drops it into the conversation as context.

**Have it:** Raycast AI Screen Awareness (https://manual.raycast.com/ai/screen-awareness).
Genuinely rare: almost nobody else ships this.

**Why it matters:** This is the highest differentiation-to-effort ratio in the whole list, and it
lands squarely in office work. The chores ZeroWork's users actually have are "explain this error
dialog," "rewrite what's selected in this contract," "what does this spreadsheet column mean" —
all of which currently require the user to describe, screenshot, paste, and crop. Raycast's design
detail is the one to copy: *"Each piece is gathered independently, so a capture still works when some
of them aren't available"* — the accessibility layer may be denied or the app may be canvas-based, and
the feature must degrade to a screenshot rather than fail. For a local-first product there is also a
privacy argument no cloud competitor can match: capture, OCR, and inference never leave the machine.

**Implementation sketch:**
- `src/main/screen-capture.js` — Electron `desktopCapturer` for the focused-window bitmap, plus a
  platform accessibility/text-extraction path. On Windows (the primary supported platform) UI
  Automation gives both the window text and the selected text; macOS requires the Accessibility
  permission and must handle denial explicitly.
- `src/main/daemon/context-providers.js` — register a `screen` context provider so a capture becomes
  a normal context item that flows through the existing pipeline and is visible in the turn trace.
- `src/renderer/src/composer.js` — hotkey registration and an "Add context → Focused window /
  Selection / Region / Full screen" menu.
- IPC: `capture:focusedWindow`, `capture:selection`, `capture:region`, plus a `capture:permission`
  status channel so the UI can explain why capture is unavailable.
- Identity: the capture host is the *only* thing that ever touches pixels. The images are written to
  the session directory so file history and the export path apply to them like any other artifact,
  and capture is itself an audit event — a screen capture is exactly the kind of action an auditable
  agent should log.

---

## 9. Annotated evidence capture as a first-class artifact

**One-line:** The agent proves its work by recording an annotated, idle-trimmed session — screenshots
or video — and attaching it to the task result instead of asserting success in prose.

**Have it:** Warp Computer Use and recordings (https://docs.warp.dev/agents/capabilities/computer-use/),
Devin Testing & Video Recordings (https://docs.devin.ai/work-with-devin/testing-and-recordings),
Cursor browser screenshots in chat (https://cursor.com/docs/agent/tools/browser).

**Why it matters:** "The agent says it worked" is the least verifiable claim in the product, and it
is the one office users have the least ability to check. Warp's implementation is instructive because
the post-processing is what makes the artifact *usable* rather than merely honest: idle and thinking
gaps are cut, action overlays are burned in with keyboard chords labeled, and — importantly for a
privacy-conscious product — *"Text typing is labeled 'typing…' to avoid leaking sensitive input."*
Devin's browser auth and recording pages take the same stance. Note this scores lower on
differentiation because the *cloud* versions are commoditized; the local-first version is not, and
the identity fit is what carries it.

**Implementation sketch:**
- `src/main/daemon/evidence.js` — an evidence recorder that captures step boundaries already present
  in the turn trace, plus optional frames from a headless or visible browser surface.
- Store under `<session>/evidence/<step>/` as a manifest plus images, so the existing file-history and
  export paths work unchanged. The manifest lists what was done and when, which is the auditable part.
- `src/renderer/src/evidence-view.js` — a step-by-step strip with captions; images render via the
  existing preview component.
- IPC: `evidence:list`, `evidence:get`, `evidence:export`.
- Scope honestly: **skip video encoding.** The startup cost of a bundler/encoder and the flakiness it
  brings outweigh the gain. Annotated screenshot sequences with a manifest deliver most of the proof
  value, stay fully local, and are diffable — which a video is not.

---

## 10. Worktree / workspace isolation for parallel agents and tasks

**One-line:** Each parallel task or subagent that is likely to touch the same files runs against an
isolated copy, so two agents cannot silently overwrite each other.

**Have it:** Cursor worktrees with `.cursor/worktrees.json` setup (https://cursor.com/docs/configuration/worktrees),
Claude Code `claude --worktree` with *enforced* isolation
(https://code.claude.com/docs/en/worktrees.md), Zed worktree isolation for parallel threads
(https://zed.dev/docs/ai/parallel-agents), OpenAI Codex cloud environments (each task gets its own).

**Why it matters:** ZeroWork already ships subagents + teams, which makes concurrent writes to the
same document a matter of time rather than a hypothetical. The failure is nasty because it is
*silent* — the last writer wins and the earlier agent's work vanishes without an error. Claude Code's
page is the most valuable reference in the survey because it documents the enforcement rather than
just the feature: it blocks edits targeting the main checkout, blocks shell commands whose working
directory cannot be **verified** to be outside it, blocks `git -C`/`GIT_DIR` redirects, and blocks
commands whose text it cannot parse to prove git stays inside. That last rule — refusing to run
anything it cannot *prove* is safe — is precisely ZeroWork's stated philosophy, and it is the version
worth copying.

**Implementation sketch:**
- `src/main/daemon/isolation.js` — a workspace-isolation manager. For office workspaces that are not
  git repos, use a plain copy-on-write directory under `<session>/isolated/<task>/` with a merge step
  at completion; when the workspace *is* a git repo, prefer real git worktrees.
- `src/main/daemon/sandbox/` — extend the existing sandbox path check from "is this path allowed" to
  "can I prove this path is inside the isolated root"; when it cannot, **refuse the call** with a
  diagnostic message, matching the existing refuse-rather-than-degrade behavior.
- `src/main/daemon/subagents.js` — an optional `isolation` flag on a spawned child; on completion,
  either auto-merge (no conflicts) or surface a conflict view.
- `src/renderer/src/team-view.js` — show which isolated root each child is working in.
- IPC: `isolation:create`, `isolation:status`, `isolation:merge`, `isolation:discard`.
- Reuse: the merge/conflict surface is the same diff machinery as interactive review (§3), so these
  two features should be built as one subsystem with two entry points.

---

## 11. Output styles (session-wide response shaping)

**One-line:** A named, switchable profile that changes *how the agent responds* — tone, verbosity,
format, and teaching posture — for every message in a session.

**Have it:** Claude Code output styles (https://code.claude.com/docs/en/output-styles.md);
Claude Desktop ships comparable style controls.

**Why it matters:** ZeroWork serves office and dev users in one app, and their formatting needs are
opposite: a developer wants terse diffs and no preamble, an office user wants a readable summary with
the conclusion first. Claude Code's built-ins are a good starter set — **Concise** ("first sentence
states the result; no preamble/narration/recap") and **Proactive** ("makes reasonable assumptions
instead of asking routine questions" while *still* checking before destructive actions) both have
direct office analogues. The feature's real value is that it is orthogonal to everything else, and
Claude Code's own comparison table is the clearest statement of why it is a distinct axis:
CLAUDE.md = what Claude should KNOW; output style = how it RESPONDS every time; skill = instructions
for ONE kind of task; hook = something that must happen EVERY time.

**Implementation sketch:**
- `src/main/daemon/output-styles.js` — style store at `~/.zerowork/output-styles/*.md` with
  frontmatter (`name`, `description`, `keep-system-instructions`). Built-ins: Default, Concise,
  Proactive, Explanatory, Learning.
- `src/main/daemon/agent-loop.js` — resolve the active style once per session and merge it into the
  system prompt *after* the base instructions, so a style can shape delivery without being able to
  weaken safety rules or tool policy. That ordering is a security property.
- `src/renderer/src/settings-output-styles.js` — picker; the file is markdown so users can write their
  own or share one.
- IPC: `outputStyles:list`, `outputStyles:setActive`, `outputStyles:save`.
- Low cost, high visible polish — but note the honest limitation: it is a system-prompt feature, so
  its reliability tracks model instruction-following, and it should be presented as a preference
  rather than a guarantee.

---

## 12. "New from summary" plus thread history archive and restore

**One-line:** Distil the current conversation into a fresh session seeded with the summary, and keep
every prior session restorable rather than merely viewable.

**Have it:** Zed New From Summary + Thread History with restore, "Zed restores the worktree
automatically" (https://zed.dev/docs/ai/agent-panel, /docs/ai/parallel-agents); Warp `/fork`,
`/fork-and-compact`, `/fork-from` (https://docs.warp.dev/agents/capabilities/slash-commands/);
Claude Code "Summarize from here" (https://code.claude.com/docs/en/checkpointing.md).

**Why it matters:** ZeroWork already has session fork-from-message and archive, so this is a
*refinement* rather than a new capability, which is why it scores lowest on differentiation and is
listed last. But the refinement is the high-value half. Zed's "New From Summary" is the graceful
answer to a blunt context limit: rather than truncate or fail, start a clean thread carrying only
what matters. Warp's `/fork-from` (fork at a specific past query) is the precise version of a
capability ZeroWork already exposes, and the combination — *summarize* when you want to shed
history, *fork-from* when you want to replay from a chosen point — is what users actually reach for.
Zed's second detail is the one worth stealing outright: on restore, if the thread had been running in
a worktree that was since removed, **the worktree is restored automatically**. Being able to restore
a conversation whose working directory is gone is what separates a real restore from a read-only
archive.

**Implementation sketch:**
- `src/main/daemon/session-store.js` — extend the existing fork path with a `summarize: true` option
  that runs the condenser (§5) over the source range and seeds the new session with the digest plus a
  pointer back to the origin session id. Because the condenser already exists for §5, this is
  mostly plumbing.
- A `/new-from-summary` command in the existing command palette, and `fork-from <message>` exposed in
  the message context menu (the session-fork capability already exists; this makes it addressable).
- `src/main/daemon/isolation.js` — on restore, re-create the isolated root or worktree if it is
  missing, mirroring Zed's behavior.
- IPC: `session:newFromSummary`, `session:forkFrom`, `session:restore`.
- Cheap, and it closes an awkward edge in an otherwise strong session-management story.

---

## Explicitly not recommended (and why)

- **Cloud-backed anything** — Claude Artifacts (requires a claude.ai login, publishes to a URL,
  https://code.claude.com/docs/en/artifacts.md), Cursor cloud agents, Warp Automation Platform,
  Devin cloud sessions. All excellent, all structurally incompatible with "local-first, no server."
  Cursor's **Canvases** are the one to note: the *idea* (agent-authored interactive artifact rendered
  beside chat, reopenable, re-runnable with fresh data) is portable to local files as generated HTML,
  but the packaged version is cloud-tied.
- **Status line as a shell script** (https://code.claude.com/docs/en/statusline.md) — delightful for
  terminal users, awkward in a GUI where a real status surface already exists. The *data* it exposes
  (context used %, cache hit ratio and miss causes, per-turn token samples) is worth surfacing in the
  existing UI; the scriptability is not.
- **Multi-harness / ACP agent hosting** (Zed External Agents, Warp third-party CLI agents, Devin ACP,
  https://zed.dev/docs/ai/external-agents) — a strong feature for a *platform* whose value is being
  the best host. ZeroWork's value is its own kernel and audit story; hosting rivals' CLIs would
  dilute the identity rather than strengthen it.
- **Motion to a browser-first IDE surface.** Cursor's worktree agents and Warp's Full Terminal Use
  are delightful but sit outside ZeroWork's office-work identity. If terminal attachment is ever
  wanted, the cheap 80% is a *live output stream with a stop button* — the long-running command
  panel — without trying to bidirectionally drive interactive apps.

## Coverage caveats

Stated honestly rather than papered over:

- **Codex** — `developers.openai.com`, `platform.openai.com`, `github.com`, and
  `raw.githubusercontent.com` all return 403/Forbidden from this host. Findings come from the
  Wikipedia article, which cites primary sources; the AGENTS.md convention and the App Server
  architecture are the load-bearing items and both are corroborated by other vendors' docs.
- **Jan** — `jan.ai` and `www.jan.ai` fail to connect entirely. Coverage is thinner than for every
  other product in the list.
- **AnythingLLM** — `docs.anythingllm.com` sits behind a Cloudflare JS challenge (403 on every path,
  including `/llms.txt`). Findings come from the product homepage and blog posts and are therefore
  marketing-level, not documentation-level.
- **Msty** — `docs.msty.ai/features` and one branch-explorer path 404; the working pages were used.
- **VS Code Copilot** — docs are client-rendered; the `.md` URL suffix convention works.
