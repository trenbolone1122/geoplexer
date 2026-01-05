import { Hono } from "hono";

const IMAGE_PROXY_TIMEOUT_MS = Number(
  process.env.IMAGE_PROXY_TIMEOUT_MS ?? 8000,
);

function isPrivateHostname(hostname: string) {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local")) return true;
  if (lower === "127.0.0.1" || lower === "::1") return true;
  if (lower.includes(":")) return true;

  const match = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)) {
    return true;
  }
  const a = parts[0];
  const b = parts[1];
  if (a === undefined || b === undefined) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function parseImageUrl(raw: string | null | undefined) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    // Use raw when it is already decoded.
  }
  let url: URL;
  try {
    url = new URL(decoded);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol)) return null;
  if (isPrivateHostname(url.hostname)) return null;
  return url;
}

export function registerImageProxy(app: Hono) {
  app.get("/image", async (c) => {
    const urlParam = c.req.query("url");
    const target = parseImageUrl(urlParam);
    if (!target) {
      return c.text("Invalid image url.", 400);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_PROXY_TIMEOUT_MS);

    try {
      const res = await fetch(target.toString(), { signal: controller.signal });
      if (!res.ok) {
        return c.text("Image fetch failed.", 502);
      }
      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.startsWith("image/")) {
        return c.text("Unsupported image response.", 415);
      }
      const headers = new Headers();
      headers.set("Content-Type", contentType);
      headers.set("Cache-Control", "public, max-age=86400, s-maxage=86400");
      return new Response(res.body, { status: 200, headers });
    } catch {
      return c.text("Image fetch failed.", 502);
    } finally {
      clearTimeout(timeout);
    }
  });
}
