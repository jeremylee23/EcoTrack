import type { VercelRequest, VercelResponse } from "@vercel/node";

type JsonObject = Record<string, unknown>;

export interface ApiErrorResponse {
  status: "error";
  code: string;
  message: string;
  timestamp: string;
}

export function sendJson(
  res: VercelResponse,
  statusCode: number,
  payload: JsonObject
): void {
  res.status(statusCode).json(payload);
}

export function sendError(
  res: VercelResponse,
  statusCode: number,
  code: string,
  message: string,
  extra: JsonObject = {}
): void {
  res.status(statusCode).json({
    status: "error",
    code,
    message,
    timestamp: new Date().toISOString(),
    ...extra,
  } satisfies ApiErrorResponse & JsonObject);
}

export function applyCors(
  res: VercelResponse,
  allowedMethods: readonly string[]
): void {
  const methods = Array.from(new Set([...allowedMethods, "OPTIONS"]));
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", methods.join(", "));
}

export function handleOptions(
  req: VercelRequest,
  res: VercelResponse
): boolean {
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }

  return false;
}

export function ensureMethod(
  req: VercelRequest,
  res: VercelResponse,
  allowedMethods: readonly string[]
): boolean {
  const method = req.method?.toUpperCase() ?? "UNKNOWN";
  if (allowedMethods.includes(method)) {
    return true;
  }

  res.setHeader("Allow", allowedMethods.join(", "));
  sendError(res, 405, "METHOD_NOT_ALLOWED", `Method ${method} Not Allowed`);
  return false;
}

export function ensureCronAuthorized(
  req: VercelRequest,
  res: VercelResponse
): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;

  const authHeader =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization
      : "";

  if (authHeader === `Bearer ${cronSecret}`) {
    return true;
  }

  sendError(res, 401, "UNAUTHORIZED", "Unauthorized");
  return false;
}