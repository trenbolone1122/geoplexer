export interface AiResponse {
  summary: string;
  facts: string[];
  nearby: string[];
  images: string[];
  sources: string[];
}

const PPLX_API_URL =
  process.env.PERPLEXITY_API_URL ||
  "https://api.perplexity.ai/chat/completions";
const PPLX_API_KEY = process.env.PERPLEXITY_API_KEY;
const PPLX_MODEL = process.env.PERPLEXITY_MODEL || "sonar-reasoning-pro";
const PPLX_TIMEOUT_MS = Number(process.env.PERPLEXITY_TIMEOUT_MS ?? 25000);
const PPLX_MAX_RETRIES = 1;
const PPLX_MAX_TOKENS = Number(process.env.PERPLEXITY_MAX_TOKENS ?? 2000);

type PplxMessage = {
  content?: string;
  citations?: unknown[];
  images?: unknown[];
};

type PplxResponse = {
  choices?: Array<{ message?: PplxMessage }>;
  citations?: unknown[];
  images?: unknown[];
};

function stripCodeFence(input: string) {
  let jsonStr = input.trim();
  if (jsonStr.startsWith("```json")) {
    jsonStr = jsonStr.slice("```json".length).trim();
  }
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.slice(3).trim();
  }
  if (jsonStr.endsWith("```")) {
    jsonStr = jsonStr.slice(0, -3).trim();
  }
  return jsonStr;
}

function stripThinkContent(input: string) {
  if (!input) return input;
  const marker = "</think>";
  const idx = input.lastIndexOf(marker);
  if (idx !== -1) {
    return input.slice(idx + marker.length).trim();
  }
  return input.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function extractValidJson(response: PplxResponse) {
  const content = response.choices?.[0]?.message?.content ?? "";
  if (!content) return null;
  const marker = "</think>";
  const idx = content.lastIndexOf(marker);
  const raw = idx === -1 ? content : content.slice(idx + marker.length);
  const jsonStr = stripCodeFence(raw);
  try {
    return JSON.parse(jsonStr) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeLink(value: unknown) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const record = value as { url?: unknown; link?: unknown; href?: unknown };
  if (typeof record.url === "string") return record.url;
  if (typeof record.link === "string") return record.link;
  if (typeof record.href === "string") return record.href;
  return null;
}

function normalizeImage(value: unknown) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const record = value as { url?: unknown; image_url?: unknown; src?: unknown };
  if (typeof record.url === "string") return record.url;
  if (typeof record.image_url === "string") return record.image_url;
  if (typeof record.src === "string") return record.src;
  return null;
}

function collectUnique(list: Array<string | null | undefined>) {
  const seen = new Set<string>();
  list.forEach((item) => {
    if (item) seen.add(item);
  });
  return Array.from(seen);
}

function extractImageUrlsFromText(text: string) {
  if (!text) return [];
  const matches = Array.from(
    text.matchAll(/\bhttps?:\/\/\S+\.(?:png|jpe?g|webp|gif)\b/gi),
  );
  return matches.map((match) => match[0] ?? "").filter(Boolean);
}

async function callPerplexity(
  systemPrompt: string,
  userPrompt: string,
): Promise<AiResponse> {
  if (!PPLX_API_KEY) {
    return {
      summary: "AI is not configured yet.",
      facts: [],
      nearby: [],
      images: [],
      sources: [],
    } satisfies AiResponse;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PPLX_TIMEOUT_MS);

  try {
    const requestOnce = async () => {
      const res = await fetch(PPLX_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${PPLX_API_KEY}`,
        },
        body: JSON.stringify({
          model: PPLX_MODEL,
          return_images: true,
          max_tokens: PPLX_MAX_TOKENS,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.3,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`AI error ${res.status}`);
      }

      return (await res.json()) as PplxResponse;
    };

    let data: PplxResponse | null = null;
    for (let attempt = 0; attempt <= PPLX_MAX_RETRIES; attempt += 1) {
      try {
        data = await requestOnce();
        break;
      } catch (error) {
        const isAbort =
          error instanceof Error &&
          (error.name === "AbortError" ||
            error.message.toLowerCase().includes("aborted"));
        if (!isAbort || attempt === PPLX_MAX_RETRIES) throw error;
      }
    }

    if (!data) {
      throw new Error(`AI request timed out after ${PPLX_TIMEOUT_MS}ms`);
    }

    const rawText =
      data.choices?.[0]?.message?.content ?? "No AI response available.";
    const text = stripThinkContent(rawText);
    const parsed = extractValidJson(data);
    const summary =
      parsed && typeof parsed.summary === "string" ? parsed.summary : text;
    const rawCitations =
      data.citations && data.citations.length > 0
        ? data.citations
        : (data.choices?.[0]?.message?.citations as unknown[]) ?? [];
    const sources = rawCitations
      .map(normalizeLink)
      .filter((item): item is string => Boolean(item));
    const images = collectUnique([
      ...(data.images ?? []).map(normalizeImage),
      ...((data.choices?.[0]?.message?.images as unknown[]) ?? []).map(
        normalizeImage,
      ),
      ...extractImageUrlsFromText(rawText),
    ]);

    return { summary, facts: [], nearby: [], images, sources } satisfies AiResponse;
  } catch (error) {
    return {
      summary:
        error instanceof Error
          ? `AI request failed: ${error.message}`
          : "AI request failed.",
      facts: [],
      nearby: [],
      images: [],
      sources: [],
    } satisfies AiResponse;
  } finally {
    clearTimeout(timeout);
  }
}

export async function enrichCity(payload: {
  name: string;
  cc: string;
  lat: number;
  lng: number;
}): Promise<AiResponse> {
  const systemPrompt = [
    "You are a world-class travel guide, cultural historian, and geographic expert.",
    "You speak with clarity, warmth, and authority — like an experienced tour guide explaining a place to an intelligent traveler.",
    "",
    "Given a geographic location (name if available, otherwise coordinates), your job is to:",
    "Identify the place accurately",
    "Give a detailed historical and cultural overview",
    "Add other relevant geographic or societal context",
    "",
    "Guidelines",
    "If a place name is provided, prioritize it.",
    "If only coordinates are provided, infer the most relevant geographic or regional context (country, region, ocean, desert, etc.).",
    "If the location is in the ocean or a remote area, explain the ocean/region, its significance, and nearby land or historical relevance.",
    "Avoid filler, emojis, or marketing language.",
    "Be informative, calm, and confident.",
    "Do not invent facts. If something is uncertain, state it clearly.",
    "",
    "Response Format",
    "Write exactly three paragraphs with a blank line between each.",
    "Do not use headings, labels, bullet points, or numbered sections.",
    "Paragraph 1: where it is (a grounded description of the location).",
    "Paragraph 2: background (history and cultural context).",
    "Paragraph 3: present day (current character, economy, culture, or environment).",
    "",
    "Tone",
    "Neutral, intelligent, and engaging",
    "Like a guide speaking to a curious adult traveler",
    "Not overly poetic, not robotic",
    "",
    "Avoid mentioning coordinates unless helpful for orientation.",
  ].join("\n");
  const userPrompt = [
    `placeName: ${payload.name}, ${payload.cc}`,
    `latitude: ${payload.lat}`,
    `longitude: ${payload.lng}`,
  ].join("\n");
  return callPerplexity(systemPrompt, userPrompt);
}

export async function enrichPoint(payload: {
  lat: number;
  lng: number;
  bestLabel: string;
  context: Record<string, unknown>;
}): Promise<AiResponse> {
  const systemPrompt = [
    "You are a world-class travel guide, cultural historian, and geographic expert.",
    "You speak with clarity, warmth, and authority — like an experienced tour guide explaining a place to an intelligent traveler.",
    "",
    "Given a geographic location (name if available, otherwise coordinates), your job is to:",
    "Identify the place accurately",
    "Give a detailed historical and cultural overview",
    "Add other relevant geographic or societal context",
    "",
    "Guidelines",
    "If a place name is provided, prioritize it.",
    "If only coordinates are provided, infer the most relevant geographic or regional context (country, region, ocean, desert, etc.).",
    "If the location is in the ocean or a remote area, explain the ocean/region, its significance, and nearby land or historical relevance.",
    "Avoid filler, emojis, or marketing language.",
    "Be informative, calm, and confident.",
    "Do not invent facts. If something is uncertain, state it clearly.",
    "",
    "Response Format",
    "Write exactly three paragraphs with a blank line between each.",
    "Do not use headings, labels, bullet points, or numbered sections.",
    "Paragraph 1: where it is (a grounded description of the location).",
    "Paragraph 2: background (history and cultural context).",
    "Paragraph 3: present day (current character, economy, culture, or environment).",
    "",
    "Tone",
    "Neutral, intelligent, and engaging",
    "Like a guide speaking to a curious adult traveler",
    "Not overly poetic, not robotic",
    "",
    "Avoid mentioning coordinates unless helpful for orientation.",
  ].join("\n");
  const userPrompt = [
    `placeName: ${payload.bestLabel}`,
    `latitude: ${payload.lat}`,
    `longitude: ${payload.lng}`,
  ].join("\n");
  return callPerplexity(systemPrompt, userPrompt);
}
