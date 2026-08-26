# mcp-fcc-ecfs

MCP server for Fcc Ecfs

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `ecfs_search_filings` | Search FCC ECFS filings using the public API full-text index. Returns filer/author, proceeding, submission type, dates, and official document links. Search matches are filings in the public record, not FCC findings or endorsements. |
| `ecfs_docket_filings` | List FCC ECFS filings in an exact proceeding/docket, newest first, including documents and parties. A filing reflects the submitter’s position and is not an FCC decision. |
| `ecfs_filing_detail` | Retrieve one FCC ECFS filing by submission ID with all public proceedings, filers, authors, law firms, status, and official document/attachment URLs. |
| `ecfs_search_proceedings` | Search FCC ECFS proceedings/dockets by exact number or public API query and return descriptions, bureau, dates, and docket links. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "fcc-ecfs": {
      "url": "https://gateway.pipeworx.io/fcc-ecfs/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/fcc-ecfs/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Fcc Ecfs data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
