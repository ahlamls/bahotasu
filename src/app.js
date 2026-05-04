import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { apiRoutes } from "./routes/api/index.js";
import { webRoutes } from "./routes/web/index.js";
import { commandRunnerRoutes } from "./routes/web/commandRunner.js";

const registerCommonRoutes = (app) => {
  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      uptime: process.uptime(),
    }),
  );
};

export const buildApp = () => {
  const app = new Hono({ strict: false });

  registerCommonRoutes(app);
  // Serve static assets (logos, images) from resources/ directory
  app.use("/static/*", serveStatic({
    root: "./resources",
    rewriteRequestPath: (p) => p.replace(/^\/static\//, "/"),
  }));
  app.route("/api", apiRoutes);
  app.route("/", commandRunnerRoutes);
  app.route("/", webRoutes);

  return app;
};

export const app = buildApp();

