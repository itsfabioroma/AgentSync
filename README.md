# Engineer Log Query MCP Server

This MCP server queries tasks from engineer logs stored in:

`~/team/<engineer>/log`

It reads Claude and Codex JSONL logs and exposes:

- MCP tool: `query-engineer-tasks`
- MCP tool: `claude-p` (equivalent to `claude -p "..."`)
- Local CLI: `claude -p "..."` (via the repo script)

## Getting Started

Install and run:

```bash
npm install
npm run dev
```

Open [http://localhost:3000/inspector](http://localhost:3000/inspector) to test MCP tools.

## CLI usage

Run the local command wrapper:

```bash
./claude -p "transcribe quota issue"
```

Optional flags:

```bash
./claude -p "export plan" --team ~/team --engineers alice,bob --limit 25
./claude -p "release tasks" --json
```

You can also run:

```bash
npm run claude -- -p "search text"
```

## Learn More

To learn more about mcp-use and MCP:

- [mcp-use Documentation](https://mcp-use.com/docs/typescript/getting-started/quickstart) — guides, API reference, and tutorials
