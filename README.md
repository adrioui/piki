<p align="center">
  <strong>Piki</strong>
</p>

<p align="center">
  <strong>An agent harness for coding, automation, and multi-provider model workflows.</strong>
</p>

<p align="center">
  <a href="https://github.com/adrioui/piki/actions"><img src="https://img.shields.io/github/actions/workflow/status/adrioui/piki/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/adrioui/piki/blob/main/LICENSE"><img src="https://img.shields.io/github/license/adrioui/piki?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.19-5FA04E?style=flat&colorA=222222&logo=node.js&logoColor=white" alt="Node.js >= 22.19"></a>
</p>

<p align="center">
  Fork of <a href="https://github.com/earendil-works/pi">earendil-works/pi</a>.
</p>

Piki is a TypeScript monorepo for an interactive coding agent, its runtime, model integrations, and terminal UI. It keeps the Pi harness foundation while adding Piki-branded packages, providers, worker runtime services, and event-core projections.

## Install

```sh
npm install -g @piki/coding-agent
```

Run the CLI:

```sh
piki
```

Run from source during development:

```sh
./pi-test.sh
```

## Packages

| Package | Description |
| --- | --- |
| [`@piki/coding-agent`](packages/coding-agent) | Interactive coding-agent CLI and SDK |
| [`@piki/agent-core`](packages/agent) | Agent loop, harness runtime, workers, and projections |
| [`@piki/ai`](packages/ai) | Unified multi-provider LLM API and provider catalog |
| [`@piki/event-core`](packages/event-core) | Event sourcing, projections, roles, and runtime primitives |
| [`@piki/tui`](packages/tui) | Terminal UI library with differential rendering |

## Highlights

- **Multi-provider models**: OpenAI-compatible providers, coding-plan providers, OAuth-backed providers, and generated model catalogs.
- **Worker runtime**: role-aware workers, lifecycle tracking, runtime events, scratchpads, and projection-backed state.
- **Agent tools**: file reads and writes, search, shell execution, web fetch/search, task coordination, checkpoints, and restore flows.
- **Extensible CLI**: examples for custom tools, providers, renderers, permissions, prompts, compaction, and UI extensions.
- **Typed foundation**: TypeScript packages with shared tests, generated shrinkwrap validation, and import compatibility checks.

## Development

```sh
npm install --ignore-scripts
npm run check
./test.sh
```

Useful package commands:

```sh
npm run build
npm run release:local -- --out /tmp/piki-local-release --force
```

## Permissions & sandboxing

Piki runs with the permissions of the user and process that launched it. For stronger filesystem, process, network, or credential boundaries, run it inside a container or sandbox. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md).

## Supply-chain hardening

- Direct external dependencies are pinned to exact versions.
- Installs use `--ignore-scripts` unless lifecycle scripts are explicitly reviewed.
- `package-lock.json` is the dependency ground truth.
- `npm run check` verifies pinned dependencies, TypeScript import compatibility, shrinkwrap generation, types, and browser smoke coverage.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json` to pin transitive dependencies for npm users.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## License

MIT
