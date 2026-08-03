# mcp-fcc-ecfs

MCP server for fcc-ecfs

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1395+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1395+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Fcc Ecfs data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
