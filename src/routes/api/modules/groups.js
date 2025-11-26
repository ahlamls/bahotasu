import { Hono } from "hono";

const router = new Hono();

router.get("/", (c) =>
  c.json({
    data: [],
    message: "Group listing not implemented",
  }),
);

router.post("/", (c) =>
  c.json(
    {
      message: "Group creation not implemented",
    },
    501,
  ),
);

export const groupRoutes = router;

