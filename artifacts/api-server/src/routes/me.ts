import { Router, type IRouter } from "express";
import { GetCurrentUserResponse } from "@workspace/api-zod";
import { attachOrgContext, requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get(
  "/me",
  requireAuth,
  attachOrgContext,
  async (req, res): Promise<void> => {
    const user = req.authUser!;
    res.json(
      GetCurrentUserResponse.parse({
        id: user.id,
        email: user.email,
        name: user.name,
        isPlatformAdmin: user.isPlatformAdmin,
        createdAt: user.createdAt,
      }),
    );
  },
);

export default router;
