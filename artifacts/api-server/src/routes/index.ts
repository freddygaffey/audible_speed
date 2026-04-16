import { Router, type IRouter } from "express";
import healthRouter from "./health";
import audibleRouter from "./audible.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(audibleRouter);

export default router;
