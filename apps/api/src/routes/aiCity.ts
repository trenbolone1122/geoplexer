import { Hono } from "hono";
import { parseLatLng } from "../core/validate.js";
import { enrichCity } from "../services/ai.js";

export function registerAiCity(app: Hono) {
  app.post("/ai/city", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid payload" }, 400);
    }

    const name = String((body as { name?: string }).name ?? "").trim();
    const cc = String((body as { cc?: string }).cc ?? "").trim();
    const latlng = parseLatLng(body);
    if (!name || !cc || !latlng) {
      return c.json({ error: "Invalid payload" }, 400);
    }

    const response = await enrichCity({
      name,
      cc,
      lat: latlng.lat,
      lng: latlng.lng,
    });
    return c.json(response);
  });
}
