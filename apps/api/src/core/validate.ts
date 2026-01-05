export type LatLng = {
  lat: number;
  lng: number;
};

export function parseLatLng(input: unknown): LatLng | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as { lat?: unknown; lng?: unknown };
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
  if (lat < -90 || lat > 90) return null;
  if (lng < -180 || lng > 180) return null;
  return { lat, lng };
}
