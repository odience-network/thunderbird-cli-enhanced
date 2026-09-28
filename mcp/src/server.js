#!/usr/bin/env node

/**
 * thunderbird-cli MCP server
 *
 * Exposes Thunderbird email management as MCP tools for Claude Desktop and
 * other MCP-compatible clients. Communicates with the local bridge daemon
 * (default: 127.0.0.1:7700) which forwards to the Thunderbird WebExtension.
 *
 * Usage:
 *   tb-mcp                                # uses defaults
 *   TB_BRIDGE_HOST=host.docker.internal tb-mcp
 *
 * Add to Claude Desktop config (claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "thunderbird": { "command": "tb-mcp" }
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createRequire } from "module";

import { api } from "./client.js";
import { tools } from "./tools.js";
import { listNotes, readNote } from "./notes.js";

const { version } = createRequire(import.meta.url)("../package.json");

// ─── Server setup ──────────────────────────────────────────────────

const server = new Server(
  {
    name: "thunderbird-cli",
    version,
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// ─── Handlers ──────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = tools.find((t) => t.name === name);

  if (!tool) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true,
    };
  }

  try {
    const result = await tool.handler(args || {}, api);
    // Deterministic "skill" tools (skill_today, skill_week, ...) hand back pre-formatted
    // Markdown meant to be read as-is, not re-serialized as a JSON string — that's the whole
    // point of a zero-LLM-reasoning tool (ODIAA-2332).
    if (result && typeof result.markdown === "string" && Object.keys(result).length === 1) {
      return { content: [{ type: "text", text: result.markdown }] };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: err.message || String(err),
            code: err.code || "UNKNOWN",
          }),
        },
      ],
      isError: true,
    };
  }
});

// Notes are exposed as MCP resources (in addition to the note_* tools) so
// clients that browse resources — rather than calling tools — can still see
// and read the local notes workspace.
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: listNotes().map((note) => ({
      uri: `note://${encodeURIComponent(note.name)}`,
      name: note.title,
      description: `Note last modified ${note.modified}`,
      mimeType: "text/markdown",
    })),
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const match = /^note:\/\/(.+)$/.exec(request.params.uri);
  if (!match) {
    throw Object.assign(new Error(`Unknown resource: ${request.params.uri}`), { code: "NOT_FOUND" });
  }
  const note = readNote(decodeURIComponent(match[1]));
  return {
    contents: [
      {
        uri: request.params.uri,
        mimeType: "text/markdown",
        text: note.body,
      },
    ],
  };
});

// ─── Start ─────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    console.log(version);
    return;
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: tb-mcp

MCP server (stdio) for Mozilla Thunderbird, ${tools.length} tools. Talks to tb-bridge.

Environment: TB_BRIDGE_HOST (default 127.0.0.1), TB_BRIDGE_PORT (default 7700),
TB_AUTH_TOKEN (only if the bridge requires it).`);
    return;
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr — stdout is reserved for MCP JSON-RPC protocol
  console.error(
    `[tb-mcp] thunderbird-cli MCP server running on stdio (${tools.length} tools)`
  );
}

main().catch((err) => {
  console.error("[tb-mcp] Fatal:", err);
  process.exit(1);
});
