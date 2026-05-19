import { serve } from "@hono/node-server";
import { app } from "./src/app.js";
import { appConfig } from "./src/config/env.js";
import { initDatabase, getDatabasePath } from "./src/db/index.js";
import { startWorker } from "./src/worker/commandWorker.js";
import { closeAllRemoteLogConnections } from "./src/services/logSource.service.js";

const start = () => {
  // Initialize database (creates tables, applies migrations including Command Runner)
  initDatabase();
  console.log(`[bahotasu] SQLite file: ${getDatabasePath()}`);

  // Start the command execution background worker
  // Polls command_executions queue every 1s, processes one at a time
  startWorker();

  serve({
    fetch: app.fetch,
    port: appConfig.port,
  });

  console.log(`[bahotasu] Environment: ${appConfig.nodeEnv}`);
  console.log(`[bahotasu] Listening on http://localhost:${appConfig.port}`);
};

/**
 * Closes pooled remote log SSH sessions on process shutdown.
 * This prevents idle pooled connections from surviving until forced process exit.
 *
 * @author OpenAI Codex GPT-5 / 2026-05-19
 */
const registerShutdownCleanup = () => {
  const cleanup = (signal) => {
    closeAllRemoteLogConnections();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
};

registerShutdownCleanup();
start();
