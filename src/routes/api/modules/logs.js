import { Hono } from "hono";

const router = new Hono();

router.get("/", (c) =>
  c.json({
    data: [],
    message: "Log configuration listing not implemented",
  }),
);

router.post("/", (c) =>
  c.json(
    {
      message: "Log registration not implemented",
    },
    501,
  ),
);

export const logRoutes = router;

