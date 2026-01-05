import { Hono } from "hono";
import { parseLatLng } from "../core/validate.js";

type PlaceItem = {
  title: string;
  rating?: number;
  reviewsCount?: number;
  category?: string;
  address?: string;
  thumbnailUrl?: string;
  link?: string;
};

export type PlacesGroup = {
  id: string;
  label: string;
  query: string;
  places: PlaceItem[];
  error?: string;
};

export type PlacesResponse = {
  groups: PlacesGroup[];
  error?: string;
};

const SERPER_MAPS_URL = "https://google.serper.dev/maps";
const SERPER_TIMEOUT_MS = Number(process.env.SERPER_TIMEOUT_MS ?? 10_000);
const SERPER_MAPS_ZOOM = Number(process.env.SERPER_MAPS_ZOOM ?? 16);

function normalizeReviews(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[,\\s]+/g, "");
    const parsed = Number(cleaned);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizePlace(item: Record<string, unknown>) {
  const title = typeof item.title === "string" ? item.title.trim() : "";
  if (!title) return null;

  const ratingRaw = (item.rating ?? item.stars ?? item.score) as
    | number
    | string
    | undefined;
  const rating = typeof ratingRaw === "string" ? Number(ratingRaw) : ratingRaw;

  const reviewsCount = normalizeReviews(
    item.reviews ?? item.userRatingsTotal ?? item.reviewsCount,
  );

  const thumbnailUrl =
    typeof item.thumbnailUrl === "string"
      ? item.thumbnailUrl
      : typeof item.imageUrl === "string"
        ? item.imageUrl
        : typeof item.thumbnail === "string"
          ? item.thumbnail
          : undefined;

  const link =
    typeof item.link === "string"
      ? item.link
      : typeof item.url === "string"
        ? item.url
        : undefined;

  const category =
    typeof item.category === "string"
      ? item.category
      : typeof item.type === "string"
        ? item.type
        : undefined;

  const address =
    typeof item.address === "string"
      ? item.address
      : typeof item.location === "string"
        ? item.location
        : undefined;

  return {
    title,
    rating: Number.isFinite(rating) ? (rating as number) : undefined,
    reviewsCount,
    category,
    address,
    thumbnailUrl,
    link,
  };
}

function extractPlaces(data: Record<string, unknown>) {
  const buckets = [
    data.places,
    (data.localResults as Record<string, unknown> | undefined)?.places,
    data.localResults,
    data.local,
    data.mapResults,
  ];

  const collected: Array<Record<string, unknown>> = [];
  for (const bucket of buckets) {
    if (Array.isArray(bucket)) {
      collected.push(
        ...bucket.filter(
          (item): item is Record<string, unknown> =>
            item && typeof item === "object",
        ),
      );
    }
  }

  return collected
    .map((item) => normalizePlace(item))
    .filter(
      (item): item is NonNullable<ReturnType<typeof normalizePlace>> =>
        Boolean(item),
    )
    .slice(0, 12);
}

const POI_KEYWORDS = [
  "tourist attraction",
  "point of interest",
  "landmark",
  "museum",
  "park",
  "historical landmark",
  "historic landmark",
  "viewpoint",
  "monument",
];

function isPoiPlace(place: PlaceItem) {
  const haystack = [place.category, place.title].filter(Boolean).join(" ").toLowerCase();
  if (!haystack) return false;
  return POI_KEYWORDS.some((keyword) => haystack.includes(keyword));
}

const RETAIL_KEYWORDS = [
  "convenience",
  "convenience store",
  "liquor store",
  "bottle shop",
  "wine shop",
  "package store",
  "grocery",
  "supermarket",
  "mini mart",
  "minimart",
  "gas station",
  "pharmacy",
  "drugstore",
];

function isRetailPlace(place: PlaceItem) {
  const haystack = [place.category, place.title].filter(Boolean).join(" ").toLowerCase();
  if (!haystack) return false;
  if (RETAIL_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return true;
  }
  if (/\b\w+\s+stores?\b/.test(haystack)) {
    return true;
  }
  return /\bstore\b/.test(haystack);
}

function placeKey(place: PlaceItem) {
  return `${place.title}::${place.address ?? ""}`.toLowerCase();
}

function normalizeZoom(value: unknown) {
  const numeric = Number(value);
  const fallback = Number.isFinite(SERPER_MAPS_ZOOM) ? SERPER_MAPS_ZOOM : 16;
  const zoom = Number.isFinite(numeric) ? numeric : fallback;
  return Math.max(3, Math.min(21, Math.round(zoom)));
}

function normalizeLl(value: unknown, latlng: { lat: number; lng: number } | null, zoom: number) {
  if (typeof value === "string") {
    let cleaned = value.trim().replace(/\\s+/g, "");
    if (!cleaned) return null;
    if (!cleaned.startsWith("@")) {
      cleaned = `@${cleaned}`;
    }
    const raw = cleaned.slice(1);
    const parts = raw.split(",");
    if (parts.length >= 2) {
      const lat = parts[0];
      const lng = parts[1];
      let zoomPart = parts[2] ?? "";
      if (!zoomPart) {
        zoomPart = `${zoom}z`;
      } else if (!/z$/i.test(zoomPart)) {
        zoomPart = `${zoomPart}z`;
      }
      return `@${lat},${lng},${zoomPart}`;
    }
  }
  if (!latlng) return null;
  return `@${latlng.lat.toFixed(4)},${latlng.lng.toFixed(4)},${zoom}z`;
}

function normalizeInterest(value: unknown, index: number) {
  if (typeof value === "string") {
    const query = value.trim();
    if (!query) return null;
    return {
      id: `interest-${index}`,
      label: query,
      query,
    };
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const label = typeof record.label === "string" ? record.label.trim() : "";
  const queryRaw =
    typeof record.query === "string"
      ? record.query.trim()
      : typeof record.q === "string"
        ? record.q.trim()
        : label;
  const idRaw = typeof record.id === "string" ? record.id.trim() : "";
  if (!queryRaw) return null;
  const id = idRaw || label.toLowerCase().replace(/\\s+/g, "-") || `interest-${index}`;
  return {
    id,
    label: label || queryRaw,
    query: queryRaw,
  };
}

async function fetchSerperPlaces(query: string, ll: string) {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    return { places: [] as PlaceItem[], error: "SERPER_API_KEY is not configured." };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERPER_TIMEOUT_MS);

  try {
    const res = await fetch(SERPER_MAPS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": apiKey,
      },
      body: JSON.stringify({ q: query, ll }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      return { places: [], error: `Serper error ${res.status}: ${text.slice(0, 120)}` };
    }

    const data = (await res.json()) as Record<string, unknown>;
    const places = extractPlaces(data);
    return { places };
  } catch (error) {
    return {
      places: [],
      error: error instanceof Error ? error.message : "Places request failed.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function registerPlaces(app: Hono) {
  app.post("/places", async (c) => {
    const body = await c.req.json().catch(() => null);
    const latlng = parseLatLng(body);
    const rawInterests = Array.isArray(body?.interests)
      ? body.interests
      : body?.interest
        ? [body.interest]
        : body?.q
          ? [body.q]
          : [];
    const interests = rawInterests
      .map((item, index) => normalizeInterest(item, index))
      .filter(
        (item): item is NonNullable<ReturnType<typeof normalizeInterest>> =>
          Boolean(item),
      );

    const zoom = normalizeZoom(body?.zoom);
    const ll = normalizeLl(body?.ll, latlng, zoom);
    if (!ll || interests.length === 0) {
      return c.json({ error: "Invalid payload", groups: [] }, 400);
    }

    const groups = await Promise.all(
      interests.map(async (interest) => {
        const result = await fetchSerperPlaces(interest.query, ll);
        const shouldFilterPoi = interest.id === "attractions";
        const places = Array.isArray(result.places)
          ? shouldFilterPoi
            ? result.places.filter(isPoiPlace)
            : result.places
          : [];
        return {
          id: interest.id,
          label: interest.label,
          query: interest.query,
          places,
          error: result.error,
        };
      }),
    );

    const nightlifeGroup = groups.find((group) => group.id === "nightlife");
    const shoppingGroup = groups.find((group) => group.id === "shopping");
    if (nightlifeGroup && Array.isArray(nightlifeGroup.places)) {
      const retailPlaces = nightlifeGroup.places.filter(isRetailPlace);
      nightlifeGroup.places = nightlifeGroup.places.filter(
        (place) => !isRetailPlace(place),
      );
      if (shoppingGroup) {
        const existing = new Map<string, PlaceItem>();
        const shoppingPlaces = Array.isArray(shoppingGroup.places)
          ? shoppingGroup.places
          : [];
        shoppingPlaces.forEach((place) => existing.set(placeKey(place), place));
        retailPlaces.forEach((place) => {
          const key = placeKey(place);
          if (!existing.has(key)) {
            existing.set(key, place);
          }
        });
        shoppingGroup.places = Array.from(existing.values());
      }
    }

    const firstError = groups.find((group) => group.error)?.error;
    return c.json({ groups, error: firstError });
  });
}
