import { Router, type IRouter } from "express";
import {
  parseWhatsAppOptOuts,
  parseWhatsAppStatuses,
  processWhatsAppOptOut,
  processWhatsAppStatus,
  verifyWebhookSignature,
} from "../services/whatsapp-webhook";

const router: IRouter = Router();

router.get("/webhooks/whatsapp", (req, res): void => {
  const token = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!token) {
    res.status(503).json({ error: "WhatsApp webhook verification is not configured" });
    return;
  }
  if (
    req.query["hub.mode"] !== "subscribe" ||
    req.query["hub.verify_token"] !== token ||
    typeof req.query["hub.challenge"] !== "string"
  ) {
    res.status(403).json({ error: "Webhook verification failed" });
    return;
  }
  res.type("text/plain").send(req.query["hub.challenge"]);
});

router.post("/webhooks/whatsapp", async (req, res): Promise<void> => {
  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    res.status(503).json({ error: "WhatsApp webhook signature validation is not configured" });
    return;
  }
  if (!Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: "Raw webhook body is required" });
    return;
  }
  const signature = typeof req.headers["x-hub-signature-256"] === "string"
    ? req.headers["x-hub-signature-256"] : undefined;
  if (!verifyWebhookSignature(req.body, signature, secret)) {
    res.status(401).json({ error: "Invalid webhook signature" });
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    res.status(400).json({ error: "Invalid webhook JSON" });
    return;
  }
  const statuses = parseWhatsAppStatuses(payload);
  for (const status of statuses) await processWhatsAppStatus(status);
  const optOuts = parseWhatsAppOptOuts(payload);
  for (const optOut of optOuts) await processWhatsAppOptOut(optOut);
  res.json({ received: true });
});

export default router;