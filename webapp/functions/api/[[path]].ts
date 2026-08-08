// Cloudflare Pages Function: transparent proxy /api/* → the Worker.
// Mirrors howler. Keeps the SPA single-origin so no CORS preflight,
// and lets the Worker live on its own *.workers.dev domain.
//
// Override per environment with the WORKER_ORIGIN Pages env var.

const DEFAULT_WORKER_ORIGIN = "https://gigsy-api.atsyg-feedme.workers.dev";

interface Env {
  WORKER_ORIGIN?: string;
}

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const origin = (env.WORKER_ORIGIN ?? DEFAULT_WORKER_ORIGIN).replace(/\/+$/, "");
  const incoming = new URL(request.url);
  const upstream = origin + incoming.pathname + incoming.search;

  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    // @ts-expect-error duplex is a valid fetch init key in workerd.
    duplex: "half",
    redirect: "manual",
  };

  return fetch(upstream, init);
};
