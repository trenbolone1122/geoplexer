import { Hono } from "hono";
import { cors } from "hono/cors";
import { registerAiCity } from "./routes/aiCity.js";
import { registerAiPoint } from "./routes/aiPoint.js";
import { registerImageProxy } from "./routes/imageProxy.js";
import { registerPlaces } from "./routes/places.js";
import { registerWeather } from "./routes/weather.js";

const corsOrigins = (process.env.CORS_ORIGIN ?? process.env.FRONTEND_ORIGIN ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

const api = new Hono();
api.use(
  "*",
  cors({
    origin: corsOrigins.length ? corsOrigins : "*",
    allowMethods: ["POST", "GET", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

api.get("/", (c) => c.json({ status: "ok" }));

registerAiCity(api);
registerAiPoint(api);
registerImageProxy(api);
registerPlaces(api);
registerWeather(api);

const app = new Hono();
app.route("/", api);
app.route("/api", api);

export default app;
