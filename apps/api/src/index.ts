import app from "./app.js";

const port = Number(process.env.PORT ?? 3000);
console.log(`Server listening on http://localhost:${port}`);

Bun.serve({
  port,
  fetch: app.fetch,
});
