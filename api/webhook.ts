/**
 * api/webhook.ts → Vercel Serverless Function: POST /api/webhook
 */

import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "crypto";
import type { webhook } from "@line/bot-sdk";
import { config } from "../src/config/index.js";
import { handleLineEvent } from "../src/webhook/handlers.js";
import {
  ensureMethod,
  sendError,
  sendJson,
} from "../src/utils/api-handler.util.js";

type Event = webhook.Event;

function validateLineSignature(
  rawBody: string,
  signature: string | string[] | undefined
): boolean {
  if (!signature || Array.isArray(signature)) return false;

  const hmac = crypto
    .createHmac("SHA256", config.line.channelSecret)
    .update(rawBody)
    .digest("base64");

  const hmacBuffer = Buffer.from(hmac);
  const sigBuffer = Buffer.from(signature);

  if (hmacBuffer.length !== sigBuffer.length) return false;
  return crypto.timingSafeEqual(hmacBuffer, sigBuffer);
}

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  if (!ensureMethod(req, res, ["POST"])) return;

  const rawBody =
    typeof req.body === "string" ? req.body : JSON.stringify(req.body);

  if (!validateLineSignature(rawBody, req.headers["x-line-signature"])) {
    console.warn("[Webhook] Rejected: invalid LINE signature");
    sendError(res, 401, "INVALID_SIGNATURE", "Invalid signature");
    return;
  }

  let events: Event[];
  try {
    const parsed =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    events = (parsed as { events: Event[] }).events ?? [];
  } catch {
    sendError(res, 400, "INVALID_JSON_BODY", "Invalid JSON body");
    return;
  }

  await Promise.allSettled(events.map(handleLineEvent));

  sendJson(res, 200, { status: "ok" });
}
