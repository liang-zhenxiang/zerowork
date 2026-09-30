<div align="center">

# ZeroWork

**A local-first AI agent for desktop work** — bringing model capability to your real files and workflows.

[![CI](https://github.com/liang-zhenxiang/zerowork/actions/workflows/ci.yml/badge.svg)](https://github.com/liang-zhenxiang/zerowork/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/liang-zhenxiang/zerowork)](https://github.com/liang-zhenxiang/zerowork/releases)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/badge?org=liang-zhenxiang&repo=zerowork)](https://github.com/ossf/scorecard)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Quick Start](#quick-start) · [Architecture](docs/ARCHITECTURE.md) · [Contributing](CONTRIBUTING.md)

[中文](README.md) | **English**

> 📖 **Note on language**: the full documentation under `docs/` is written in Chinese,
> where most of this project's design rationale lives. This page covers what you need
> to get started. Contributions that improve the English documentation are welcome.

</div>

---

## What this is

A desktop application that lets an AI agent do real work on your own machine —
reading and writing files, parsing documents, running commands, and executing tasks on a schedule.

- **Electron + React 19**; the agent core is built on
  [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
- **Provider-agnostic**: any OpenAI-compatible endpoint works, including local models and self-hosted gateways
- **Local-first**: every outbound request is documented in [EXTERNAL_REQUESTS.md](EXTERNAL_REQUESTS.md)
- **Secure by default**: under the restricted permission tiers the app refuses to run a command
  rather than running it unconstrained and silently

> ⚠️ This project is at **0.x**, and **Windows is the only fully supported platform** —
> the command sandbox relies on Windows-specific system calls. On macOS everything except
> command execution works; Linux is not adapted. See [Platform support](#platform-support).

## Features

| Capability | Description |
| --- | --- |
| **Scenarios** | Code / office work / document processing / data analysis / deep research / slides |
| **Experts & skills** | A dozen packaged experts plus on-demand skills |
| **MCP connectors** | External tools over stdio or HTTP; tool calls always **ask for permission** |
| **Document parsing** | Read and regenerate PDF / Office / DOCX |
| **Scheduled tasks** | Fire a prompt on a schedule, in a fresh session |
| **Sessions** | Archive, branch from **any** historical message, usage accounting |
| **Audit** | Four event categories are recorded — including the act of **erasing the log** |
| **Permissions & sandbox** | Three tiers, model-independent permission evaluation, sandboxed execution |

## Quick start

### Installer

Download from [Releases](https://github.com/liang-zhenxiang/zerowork/releases).

> ⚠️ **The installers are unsigned.** On macOS, right-click → **Open** for the first launch
> (double-clicking will be blocked). On Windows, SmartScreen will warn you — click
> "More info" → "Run anyway". This is the unavoidable consequence of shipping without a
> code-signing certificate, not a packaging error. See the
> [troubleshooting guide](docs/TROUBLESHOOTING.md#安装包被系统拦下) (Chinese).

### From source

```bash
npm ci
npm run dev     # dev mode, renderer hot reload
```

When running unpacked, you must point the app at its resources and config directories:

```bash
ZEROWORK_CONFIG_DIR=/tmp/zerowork-dev \
ZEROWORK_RESOURCES_DIR=$PWD/resources \
npm run dev
```

Then connect a model (**Settings → Model**) — any OpenAI-compatible endpoint.
See the [usage guide](docs/USAGE.md) (Chinese) for details.

## Platform support

| Capability | Windows | macOS | Linux |
| --- | :---: | :---: | :---: |
| App shell / UI / IPC | ✅ | ✅ | ✅ |
| Model chat / agent loop | ✅ | ✅ | ✅ |
| Document parsing (PDF / Office / docx) | ✅ | ✅ | ✅ |
| **Command execution** | ✅ sandboxed | ⚠️ refused in restricted tiers | ⚠️ refused in restricted tiers |
| Managed runtimes | ✅ Node / Bash / Python | 🔶 Node / Python | 🔶 Python |

### About the command sandbox

The sandbox calls into Windows' `kernel32` / `advapi32` via `koffi` — it is **Windows-only**.
On macOS and Linux, commands are therefore **refused outright** under the default tier:

**This is a deliberate security decision**: refusing to run is better than running
unconstrained without telling you — otherwise the "restricted" tier would be decorative.

**This is also why there is no Linux installer**: shipping a build that opens a window
but refuses to run commands would be advertising platform support that does not exist.

## Documentation

| Document | Audience |
| --- | --- |
| [docs/USAGE.md](docs/USAGE.md) | **Users** — install, model setup, each area of the UI, permissions, platform differences |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | **Anyone hitting a problem** — search by the error text you saw |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **People changing code** — process model, modules, and *why* it is built this way |
| [docs/DESIGN.md](docs/DESIGN.md) | **People changing the UI** — design-token tiers and the prohibition list |
| [CONTRIBUTING.md](CONTRIBUTING.md) | **Contributors** — local checks, commit convention, branching |
| [SECURITY.md](SECURITY.md) | **Anyone reporting a vulnerability** — includes the threat model |

## Technical shape

Two structural facts worth knowing before reading the code (details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)):

1. **The source is JavaScript + JSDoc**; type checking runs through `tsc`, with `checkJs` currently off —
   the reasoning and the incremental path are documented.
2. **The renderer is organised by build chunk, not by component** — `src/renderer/src/app.js`
   alone is ~68k lines. This is deliberate: automatic splitting cannot produce a readable,
   reliable partition, and the rationale plus four manual split candidates are documented.

```bash
npm run test:all    # static checks + unit tests + end-to-end GUI tests
```

## Roadmap

The single source of truth for the roadmap is
**[Roadmap Issue #21](https://github.com/liang-zhenxiang/zerowork/issues/21)**.

## Contributing

Bug reports, documentation fixes and tests are all welcome —
start with [CONTRIBUTING.md](CONTRIBUTING.md).
Look for [`good first issue`](https://github.com/liang-zhenxiang/zerowork/labels/good%20first%20issue)
labels; those issues state which file to start from.

Participation implies agreement with the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

**Apache License 2.0**, see [LICENSE](LICENSE).

This project depends on third-party packages (including `@earendil-works/pi-coding-agent`)
and bundles third-party resources under their own licenses —
all itemised in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

> ⚠️ Items marked as unconfirmed in `THIRD_PARTY_NOTICES.md` must be resolved
> before assuming any right to redistribute.
