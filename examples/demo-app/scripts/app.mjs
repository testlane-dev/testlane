#!/usr/bin/env node
/**
 * Private Next.js bootstrap for the demo.
 *
 * The parent sends the generated configuration once over stdin. This process
 * installs it in the in-memory runtime provider before Next prepares routes;
 * no secret is placed in an environment variable, argument, or file.
 */
import http from "node:http";
import next from "next";
import { initializeRuntimeConfig } from "../lib/runtime-config.js";

function safeStartupFailure() {
  process.stderr.write("[demo-app] unable to initialize the demo app\n");
  process.exitCode = 1;
}

async function readBootstrap() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString("utf8");
  if (body.length === 0 || body.length > 16_384) throw new Error("invalid bootstrap");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("invalid bootstrap");
  }
  initializeRuntimeConfig(parsed);
}

async function main() {
  await readBootstrap();
  const rawPort = process.argv[2];
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid port");
  const app = next({ dev: true, hostname: "localhost", port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const server = http.createServer((request, response) => handle(request, response));
  server.on("error", () => {
    process.stderr.write("[demo-app] server failed to start\n");
    process.exitCode = 1;
  });
  server.listen(port, "localhost");
}

main().catch(() => safeStartupFailure());
