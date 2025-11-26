import { Hono } from "hono";
import { authRoutes } from "./modules/auth.js";
import { groupRoutes } from "./modules/groups.js";
import { logRoutes } from "./modules/logs.js";
import { userRoutes } from "./modules/users.js";

const api = new Hono({ strict: false });

api.route("/auth", authRoutes);
api.route("/groups", groupRoutes);
api.route("/logs", logRoutes);
api.route("/users", userRoutes);

api.get("/", (c) =>
  c.json({
    name: "bahotasu",
    description: "Log monitoring API",
    routes: ["auth", "groups", "logs", "users"],
  }),
);

export const apiRoutes = api;

