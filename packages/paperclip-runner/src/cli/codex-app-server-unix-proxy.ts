#!/usr/bin/env node
import { createConnection } from "node:net";

function socketArgument(argv: string[]): string {
  const index = argv.indexOf("--socket");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error("--socket requires a Unix socket path");
  return value;
}

try {
  const socket = createConnection(socketArgument(process.argv.slice(2)));
  socket.once("connect", () => {
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });
  socket.once("error", (error) => {
    process.stderr.write(`Codex app-server socket error: ${error.message}\n`);
    process.exitCode = 1;
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
