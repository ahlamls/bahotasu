import { Hono } from "hono";

const router = new Hono();

router.post("/login", (c) =>
  c.json(
    {
      message: "Login endpoint placeholder",
    },
    501,
  ),
);

router.post("/logout", (c) =>
  c.json(
    {
      message: "Logout endpoint placeholder",
    },
    501,
  ),
);

export const authRoutes = router;

