<p align="center">
  <strong>Piki</strong>
</p>

<p align="center">
  <strong>A coding agent that runs in your terminal.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@piki/coding-agent"><img src="https://img.shields.io/npm/v/@piki/coding-agent?style=flat&colorA=222222&colorB=CB3837" alt="npm version"></a>
  <a href="https://github.com/adrioui/piki/blob/main/packages/coding-agent/CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-keep-E05735?style=flat&colorA=222222" alt="Changelog"></a>
  <a href="https://github.com/adrioui/piki/actions"><img src="https://img.shields.io/github/actions/workflow/status/adrioui/piki/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/adrioui/piki/blob/main/LICENSE"><img src="https://img.shields.io/github/license/adrioui/piki?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.19-5FA04E?style=flat&colorA=222222&logo=node.js&logoColor=white" alt="Node.js >= 22.19"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

Piki is a TypeScript coding agent. It runs in your terminal, talks to 40+ LLM providers, and drives real tools against your codebase — read, edit, search, shell, web. Sessions resume, fork, and compact; subagents fan out work; extensions and skills bend the agent to your workflow.

## Install

**npm**

```sh
npm install -g @piki/coding-agent
piki
```

**bun**

```sh
bun install -g @piki/coding-agent
piki
```

**Run from source during development**

```sh
npm install --ignore-scripts
npm run build
node packages/coding-agent/dist/cli.js
```

## Features

### 01 · Multi-provider model support

Piki speaks to 40+ providers through one client: Anthropic, OpenAI, Google Gemini, xAI, Mistral, Groq, Cerebras, Fireworks, Together, Hugging Face, OpenRouter, Amazon Bedrock, Azure OpenAI, Cloudflare AI Gateway, GitHub Copilot, and more. Switch providers per run with `--provider`/`--model`, or override mid-session from the TUI.

### 02 · Full terminal UI

Tool calls render as cards — reads, edits with diffs, shell output, web results. Edits preview before they land, so you see the change before the disk moves. The TUI is the default surface; ambiguity routes back to you through a structured option picker.

### 03 · Subagent fan-out

Split a job across workers and read typed results back. The `spawn-worker` tool fans work out into isolated contexts, each running its own tool surface; a leader coordinates, reassigns, and messages workers. No prose to parse, no orphaned edits.

### 04 · Session management

Resume a session where you left off, fork it to try a different approach, and compact long runs to keep context bounded without losing the thread. Snapshots mark conversation state; roll back when an experiment goes sideways.

### 05 · Extensions system

Piki loads TypeScript extensions from npm, git, or local paths. Add custom tools, slash commands, keybindings, and renderers without touching core. Hot-reload with `/reload`. The example extensions ship a starter kit: hello-world tools, custom providers, notify hooks, and a minimal mode.

### 06 · Skills system

Skills are markdown files that capture preferred workflows. The `skill` tool discovers and loads them on demand, so repeatable procedures stay documented and runnable instead of living in prose.

### 07 · Web search and web fetch

`web_search` returns ranked, cited sources; `web_fetch` pulls a URL straight into structured markdown with anchors intact. Research, docs, and registries all come back in the same shape as a local file read.

### 08 · File tools with semantic search

`read`, `write`, and `edit` cover the file lifecycle. `grep`, `tree`, `find`, and `view` search and navigate the tree. `grep` runs on embedded ripgrep bindings, so searches return instantly without a fork-exec round-trip.

### 09 · Scratchpad workspace for agent memory

Workers share a scratchpad directory across the session — reports, designs, and intermediate findings land in one place. The `scratchpad-save` and `scratchpad-load` tools let the agent persist and retrieve context between turns and across subagents.

### 10 · RPC and serve modes

`piki --mode rpc` drives the agent over stdio with NDJSON commands and event frames — for non-Node embedders or process isolation. `piki serve` exposes the same engine as a service.

## Install details

```sh
npm install -g @piki/coding-agent
```

Then run the CLI:

```sh
piki
```

For a one-shot answer instead of the interactive TUI:

```sh
piki -p "list the .ts files in this repo"
```

## Monorepo Packages

| Package | Description |
| --- | --- |
| [`@piki/coding-agent`](packages/coding-agent) | Interactive coding agent CLI and SDK |
| [`@piki/agent-core`](packages/agent) | Agent runtime with tool calling and state management |
| [`@piki/ai`](packages/ai) | Multi-provider LLM client with streaming |
| [`@piki/tui`](packages/tui) | Terminal UI library with differential rendering |
| [`@piki/event-core`](packages/event-core) | Event-driven projection/worker framework |
| [`@piki/harness`](packages/harness) | Tool harness with stateful tool definitions |
| [`@piki/roles`](packages/roles) | Role definitions for leader/scout/engineer/etc. workers |
| [`@piki/storage`](packages/storage) | Storage abstractions (in-memory KV, paths) |
| [`@piki/scratchpad`](packages/scratchpad) | Shared scratchpad workspace for agents |
| [`@piki/skills`](packages/skills) | Skill file discovery and loading |
| [`@piki/ripgrep`](packages/ripgrep) | Embedded ripgrep bindings |
| [`@piki/vcs`](packages/vcs) | Git/VCS integration |
| [`@piki/tracing`](packages/tracing) | Telemetry and tracing utilities |
| [`@piki/logger`](packages/logger) | Logging utilities |
| [`@piki/generate-id`](packages/generate-id) | ID generation utilities |
| [`@piki/shell-classifier`](packages/shell-classifier) | Shell command classification |
| [`@piki/orchestrator`](packages/orchestrator) | Multi-agent orchestration |
| [`@piki/piki-client`](packages/piki-client) | Client library for the Piki API |

## Development

```sh
npm install --ignore-scripts
npm run build
npm run check
```

`npm run check` verifies pinned dependencies, TypeScript import compatibility, shrinkwrap generation, types, and browser smoke coverage. For tests, run `./test.sh` from the repo root.

Useful package commands:

```sh
npm run release:local -- --out /tmp/piki-local-release --force
```

## Supply-chain hardening

- Direct external dependencies are pinned to exact versions.
- Installs use `--ignore-scripts` unless lifecycle scripts are explicitly reviewed.
- `package-lock.json` is the dependency ground truth.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json` to pin transitive dependencies for npm users.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

MIT. See [LICENSE](LICENSE).
