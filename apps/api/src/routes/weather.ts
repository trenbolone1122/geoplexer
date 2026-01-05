import { Hono } from "hono";
import { parseLatLng, type LatLng } from "../core/validate.js";

export type WeatherResponse = {
  latitude: number;
  longitude: number;
  timezone?: string;
  current?: {
    time?: string;
    temperature_2m?: number;
    wind_speed_10m?: number;
    weather_code?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    relative_humidity_2m?: number[];
    wind_speed_10m?: number[];
  };
};

async function fetchWeather(latlng: LatLng) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", latlng.lat.toString());
  url.searchParams.set("longitude", latlng.lng.toString());
  url.searchParams.set(
    "current",
    "temperature_2m,wind_speed_10m,weather_code",
  );
  url.searchParams.set(
    "hourly",
    "temperature_2m,relative_humidity_2m,wind_speed_10m",
  );

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Weather error ${res.status}`);
  }
  return (await res.json()) as WeatherResponse;
}

export function registerWeather(app: Hono) {
  app.post("/weather", async (c) => {
    const body = await c.req.json().catch(() => null);
    const latlng = parseLatLng(body);
    if (!latlng) {
      return c.json({ error: "Invalid lat/lng" }, 400);
    }

    const response = await fetchWeather(latlng);
    return c.json(response);
  });
}
