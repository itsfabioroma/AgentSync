# AgentSync (Ultracontext MCP)

AgentSync is a context layer for distributed AI teams.

Ultracontext ingests the working context from coding agents across themes/teams, and exposes it through MCP so you can query from ChatGPT (or any MCP-compatible agent) and get near real-time visibility into what the team is doing.

## What It Does

- Aggregates Claude/Codex JSONL activity from distributed engineering agents.
- Supports team layouts like:
  - `teams/<theme>/<engineer>/log`
  - `<teamRoot>/<engineer>/log`
- Exposes MCP tools to query cross-team context:
  - `query-context`
  - `search-tools` (compatibility alias)
- Returns results in a dashboard-oriented widget so context is easy to inspect.

## Quick Start

```bash
npm install
npm run dev
```

Open the MCP inspector:

- [http://localhost:3000/inspector](http://localhost:3000/inspector)

## Example MCP Queries

Ask directly from ChatGPT or another MCP client, for example:

- "What is Maya currently working on?"
- "Show recent backend work about auth middleware."
- "What changed this week in machinelearning?"

Optional filters:

- `teams: ["backend"]`
- `engineers: ["maya"]`
- `limit: 20`

## Demo Sync: Pull Fabio Sessions From Ultracontext

Pull sessions discovered by the local Ultracontext daemon cache and write them into this demo's team log folder:

```bash
npm run demo:pull-fabio-sessions
```

By default, output is written to:

- `teams/demo/fabio/log`

Useful flags:

```bash
npm run demo:pull-fabio-sessions -- --dry-run
npm run demo:pull-fabio-sessions -- --engineer-id engineer-01 --host Fabios-MacBook-Pro.local
npm run demo:pull-fabio-sessions -- --source codex --limit 80
npm run demo:pull-fabio-sessions -- --out-dir teams/backend/fabio/log
```

Notes:

- Reads daemon cache from `~/.ultracontext/daemon.db` (or `--db-path`).
- Uses `ULTRACONTEXT_API_KEY`, `--api-key`, or `~/.ultracontext/config.toml`.
- Writes `.jsonl` files used by this demo plus `index.json` and raw payloads under `_raw/`.

Auto-refresh behavior:

- After each MCP query call (`query-context` or `search-tools`), the server queues a background Fabio sync.
- This keeps `teams/demo/fabio/log` fresh without blocking the current query response.
- Disable with `AUTO_SYNC_FABIO_SESSIONS=false`.
- Optional override: `AUTO_SYNC_FABIO_SESSIONS_OUT_DIR`
- Optional override: `AUTO_SYNC_FABIO_SESSIONS_ENGINEER_ID`
- Optional override: `AUTO_SYNC_FABIO_SESSIONS_HOST`
- Optional override: `AUTO_SYNC_FABIO_SESSIONS_SOURCE` (`all|codex|claude`)
- Optional override: `AUTO_SYNC_FABIO_SESSIONS_LIMIT`

## Learn More

- [mcp-use Documentation](https://mcp-use.com/docs/typescript/getting-started/quickstart)
