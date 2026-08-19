# codex-lb

![codex-lb](docs/screenshots/banner.jpg)

[Tiếng Việt](./README.md) | **English**

Load balancer for ChatGPT accounts. Pool multiple accounts, track usage, manage API keys, view everything in a dashboard.

**Documentation:** View all guides in [docs/](docs/index.md) — getting started, client setup, configuration, deployment, troubleshooting, and more screenshots.

## Features

<table>
<tr>
<td><b>Account Pooling</b><br>Load balance across multiple ChatGPT accounts</td>
<td><b>Usage Tracking</b><br>Per-account tokens, cost, 28-day trends</td>
<td><b>API Keys</b><br>Per-key rate limits by token, cost, window, model</td>
</tr>
<tr>
<td><b>Dashboard Auth</b><br>Password + optional TOTP</td>
<td><b>OpenAI-compatible</b><br>Codex CLI, OpenCode, any OpenAI client</td>
<td><b>Auto Model Sync</b><br>Available models fetched from upstream</td>
</tr>
</table>

| ![dashboard](docs/screenshots/dashboard.jpg) | ![accounts](docs/screenshots/accounts.jpg) |
|:---:|:---:|

## Quick Start

```bash
# Docker (recommended)
docker volume create codex-lb-data
docker network inspect codex-lb-net >/dev/null 2>&1 || docker network create codex-lb-net
docker run -d --name codex-lb \
  --network codex-lb-net \
  -p 2455:2455 -p 1455:1455 \
  -v codex-lb-data:/var/lib/codex-lb \
  ghcr.io/vanle1101/codex-lb:latest

# or uvx
uvx codex-lb
```

Open [localhost:2455](http://localhost:2455) → Add account → Done.

Accessing the dashboard remotely for the first time? You need a one-time bootstrap token —
see [Getting started](docs/getting-started.md).

## Client Setup

Point any OpenAI-compatible client at codex-lb. For Codex CLI, `~/.codex/config.toml`:

```toml
model = "gpt-5.6-sol"
model_reasoning_effort = "xhigh"
model_provider = "codex-lb"

[model_providers.codex-lb]
name = "openai"  # required — enables remote /responses/compact
base_url = "http://127.0.0.1:2455/backend-api/codex"
wire_api = "responses"
supports_websockets = true
requires_openai_auth = true # required for codex app
```

| Logo | Client | Endpoint | Guide |
|---|--------|----------|-------|
| <img src="https://avatars.githubusercontent.com/u/14957082?s=200" width="32" alt="OpenAI"> | **Codex CLI / IDE** | `http://127.0.0.1:2455/backend-api/codex` | [Client setup → Codex CLI](docs/client-setup.md#codex-cli-ide-extension) |
| <img src="https://avatars.githubusercontent.com/u/66570915?s=200" width="32" alt="OpenCode"> | **OpenCode** | `http://127.0.0.1:2455/v1` | [Client setup → OpenCode](docs/client-setup.md#opencode) |
| <img src="https://avatars.githubusercontent.com/u/252820863?s=200" width="32" alt="OpenClaw"> | **OpenClaw** | `http://127.0.0.1:2455/v1` | [Client setup → OpenClaw](docs/client-setup.md#openclaw) |
| <img src="https://avatars.githubusercontent.com/u/134168893?s=200" width="32" alt="Hermes Agent"> | **Hermes Agent** | `http://127.0.0.1:2455/v1` | [Client setup → Hermes Agent](docs/client-setup.md#hermes-agent) |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/python/python-original.svg" width="32" alt="Python"> | **OpenAI Python SDK** | `http://127.0.0.1:2455/v1` | [Client setup → Python SDK](docs/client-setup.md#openai-python-sdk) |

Remote clients need an [API key](docs/api-keys.md) created from the dashboard.

## Configuration

Environment variables with `CODEX_LB_` prefix or `.env.local` — see [`.env.example`](.env.example) and the
[configuration guide](docs/configuration.md). SQLite is the default database backend;
PostgreSQL is optional via `CODEX_LB_DATABASE_URL`.

## Data

| Environment | Path |
|-------------|------|
| Local / uvx | `~/.codex-lb/` |
| Docker | `/var/lib/codex-lb/` |

Backup this directory to preserve your data.

## Documentation

Full docs live in [docs/](docs/index.md):

- [Getting started](docs/getting-started.md) — quick start, remote bootstrap token
- [Client setup](docs/client-setup.md) — Codex CLI, OpenCode, OpenClaw, Python SDK
- [Configuration](docs/configuration.md) — the few settings that matter
- [Authentication](docs/authentication.md) — dashboard auth modes
- [API keys](docs/api-keys.md) — protecting proxy routes
- [Routing](docs/routing.md) — strategy guide
- [Database](docs/database.md) — SQLite / PostgreSQL, Postgres 16 → 18 upgrade
- [Deployment](docs/deployment/docker.md) — Docker, Kubernetes, remote access
- [Troubleshooting](docs/troubleshooting.md) — common issues and fixes

## Development

```bash
# Docker
docker compose watch

# Local
uv sync && cd frontend && bun install && cd ..
uv run codex-lb                              # backend :2455
```
