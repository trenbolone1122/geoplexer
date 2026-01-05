import { Hono } from "hono";
import { parseLatLng } from "../core/validate.js";
import { enrichPoint } from "../services/ai.js";

export function registerAiPoint(app: Hono) {
  app.post("/ai/point", async (c) => {
    const body = await c.req.json().catch(() => null);
    const latlng = parseLatLng(body);
    if (!latlng) {
      return c.json({ error: "Invalid lat/lng" }, 400);
    }

    const bestLabel = String((body as { bestLabel?: string }).bestLabel ?? "").trim();
    const context = (body as { context?: Record<string, unknown> }).context ?? {};
    if (!bestLabel) {
      return c.json({ error: "Missing bestLabel" }, 400);
    }

    const response = await enrichPoint({
      lat: latlng.lat,
      lng: latlng.lng,
      bestLabel,
      context,
    });
    return c.json(response);
  });
}
