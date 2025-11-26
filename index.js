import { serve } from "@hono/node-server";
import { app } from "./src/app.js";
import { appConfig } from "./src/config/env.js";
import { initDatabase, getDatabasePath } from "./src/db/index.js";

const start = () => {
  initDatabase();
  console.log(`[bahotasu] SQLite file: ${getDatabasePath()}`);

  serve({
    fetch: app.fetch,
    port: appConfig.port,
  });

  console.log(`[bahotasu] Environment: ${appConfig.nodeEnv}`);
  console.log(`[bahotasu] Listening on http://localhost:${appConfig.port}`);
};

start();
