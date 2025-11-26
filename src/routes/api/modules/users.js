import { Hono } from "hono";

const router = new Hono();

router.get("/", (c) =>
  c.json({
    data: [],
    message: "User listing not implemented",
  }),
);

router.post("/", (c) =>
  c.json(
    {
      message: "User creation not implemented",
    },
    501,
  ),
);

export const userRoutes = router;

