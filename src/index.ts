#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer } from "./mcp-proxy.js";
import { Command } from "commander";
import { reportAllTools } from "./report-tools.js";
import { cleanupAllSessions } from "./sessions.js";
import express from "express";

const program = new Command();

program
  .name("mcp-server-metamcp")
  .description("MetaMCP MCP Server - The One MCP to manage all your MCPs")
  .option(
    "--metamcp-api-key <key>",
    "API key for MetaMCP (can also be set via METAMCP_API_KEY env var)"
  )
  .option(
    "--metamcp-api-base-url <url>",
    "Base URL for MetaMCP API (can also be set via METAMCP_API_BASE_URL env var)"
  )
  .option(
    "--report",
    "Fetch all MCPs, initialize clients, and report tools to MetaMCP API"
  )
  .option("--transport <type>", "Transport type to use (stdio or sse)", "stdio")
  .option("--port <port>", "Port to use for SSE transport", "3001")
  .parse(process.argv);

const options = program.opts();

// Set environment variables from command line arguments
if (options.metamcpApiKey) {
  process.env.METAMCP_API_KEY = options.metamcpApiKey;
}
if (options.metamcpApiBaseUrl) {
  process.env.METAMCP_API_BASE_URL = options.metamcpApiBaseUrl;
}

async function main() {
  // If --report flag is set, run the reporting function instead of starting the server
  if (options.report) {
    await reportAllTools();
    await cleanupAllSessions();
    return;
  }

  const { server, cleanup } = await createServer();

  if (options.transport.toLowerCase() === "sse") {
    // Start SSE server
    const app = express();
    const port = parseInt(options.port) || 12006;

    // to support multiple simultaneous connections we have a lookup object from
    // sessionId to transport
    const transports: { [sessionId: string]: SSEServerTransport } = {};

    app.get("/sse", async (_: express.Request, res: express.Response) => {
      const transport = new SSEServerTransport("/messages", res);
      transports[transport.sessionId] = transport;
      res.on("close", () => {
        delete transports[transport.sessionId];
      });
      await server.connect(transport);
    });

    app.post(
      "/messages",
      async (req: express.Request, res: express.Response) => {
        const sessionId = req.query.sessionId as string;
        const transport = transports[sessionId];
        if (transport) {
          await transport.handlePostMessage(req, res);
        } else {
          res.status(400).send("No transport found for sessionId");
        }
      }
    );

    app.listen(port, () => {
      console.log(`SSE server listening on port ${port}`);
    });

    // Cleanup on exit
    const handleExit = async () => {
      await cleanup();
      // Close all active transports
      await Promise.all(
        Object.values(transports).map((transport) => transport.close())
      );
      await server.close();
      process.exit(0);
    };

    process.on("SIGINT", handleExit);
    process.on("SIGTERM", handleExit);
  } else {
    // Default: Start stdio server
    const transport = new StdioServerTransport();
    await server.connect(transport);

    const handleExit = async () => {
      await cleanup();
      await transport.close();
      await server.close();
      process.exit(0);
    };

    // Cleanup on exit
    process.on("SIGINT", handleExit);
    process.on("SIGTERM", handleExit);

    process.stdin.resume();
    process.stdin.on("end", handleExit);
    process.stdin.on("close", handleExit);
  }
}

main().catch((error) => {
  console.error("Server error:", error);
});
