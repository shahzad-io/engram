import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Server } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadEnvFile, requireEnv } from "../infrastructure/env.js";
import { createMcpServer } from "./server.js";

async function connectClient(): Promise<Client> {
  await loadEnvFile();
  const client = new Client({ connectionString: requireEnv("PKE_DATABASE_URL") });
  await client.connect();
  return client;
}

async function buildTimestamp(): Promise<string> {
  try {
    const metadata = await stat(fileURLToPath(import.meta.url));
    return metadata.mtime.toISOString();
  } catch {
    return "unknown";
  }
}

async function announceStartup(): Promise<void> {
  console.error(`[pke-mcp] startup build_timestamp=${await buildTimestamp()}`);
}

export async function runStdioMcp(): Promise<void> {
  await announceStartup();
  const client = await connectClient();
  const server = createMcpServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export async function runHttpMcp(options: {
  readonly host?: string;
  readonly port?: number;
} = {}): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  await announceStartup();
  const client = await connectClient();
  const app = createMcpExpressApp({ host });
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"];
    try {
      let transport: StreamableHTTPServerTransport | undefined;
      if (typeof sessionId === "string" && transports.has(sessionId)) {
        transport = transports.get(sessionId);
        if (transport === undefined) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session ID provided" },
            id: null,
          });
          return;
        }
        await transport.handleRequest(req, res, req.body);
        return;
      } else if (sessionId === undefined && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            if (transport !== undefined) {
              transports.set(id, transport);
            }
          },
        });
        transport.onclose = () => {
          const id = transport?.sessionId;
          if (id !== undefined) {
            transports.delete(id);
          }
        };
        const sessionServer = createMcpServer(client);
        await sessionServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
      console.error(error);
    }
  });

  app.get("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string") {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    const transport = transports.get(sessionId);
    if (transport === undefined) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  });

  app.delete("/mcp", async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"];
    if (typeof sessionId !== "string") {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    const transport = transports.get(sessionId);
    if (transport === undefined) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }
    await transport.handleRequest(req, res);
  });

  return await new Promise((resolve, reject) => {
    const httpServer = app.listen(port, host, (error?: Error) => {
      if (error !== undefined) {
        reject(error);
        return;
      }
      console.error(`PKE MCP HTTP server listening on http://${host}:${port}/mcp`);
      resolve(httpServer);
    });
  });
}

export { createMcpServer } from "./server.js";
export {
  handleArtifactGet,
  handleContextBuild,
  handleDiscussionResolve,
  handleGraphExpand,
} from "./handlers.js";
