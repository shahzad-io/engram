import type { Client } from "pg";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  handleArtifactGet,
  handleContextBuild,
  handleDiscussionResolve,
  handleGraphExpand,
  registerToolPair,
} from "./handlers.js";
import {
  TOOL_DESCRIPTIONS,
  artifactGetInputSchema,
  contextBuildInputSchema,
  discussionResolveInputSchema,
  dottedToUnderscore,
  graphExpandInputSchema,
} from "./schemas.js";

export function createMcpServer(client: Client): McpServer {
  const server = new McpServer({
    name: "pke",
    version: "0.0.0",
  });

  registerToolPair(server, client, {
    name: "context.build",
    alias: dottedToUnderscore("context.build"),
    description: TOOL_DESCRIPTIONS["context.build"],
    inputSchema: contextBuildInputSchema,
    handler: handleContextBuild,
  });

  registerToolPair(server, client, {
    name: "graph.expand",
    alias: dottedToUnderscore("graph.expand"),
    description: TOOL_DESCRIPTIONS["graph.expand"],
    inputSchema: graphExpandInputSchema,
    handler: handleGraphExpand,
  });

  registerToolPair(server, client, {
    name: "discussion.resolve",
    alias: dottedToUnderscore("discussion.resolve"),
    description: TOOL_DESCRIPTIONS["discussion.resolve"],
    inputSchema: discussionResolveInputSchema,
    handler: handleDiscussionResolve,
  });

  registerToolPair(server, client, {
    name: "artifact.get",
    alias: dottedToUnderscore("artifact.get"),
    description: TOOL_DESCRIPTIONS["artifact.get"],
    inputSchema: artifactGetInputSchema,
    handler: handleArtifactGet,
  });

  return server;
}
