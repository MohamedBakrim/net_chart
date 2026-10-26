/* bakrim filter UI — tiny zero-dependency Node server.
 *
 * Serves the /filter management page and its API:
 *   GET    /filter/api/rules   → current blocked-host list
 *   POST   /filter/api/rules   → add    { "host": "example.com" }
 *   DELETE /filter/api/rules   → remove { "host": "example.com" }
 *
 * The list lives in a ConfigMap (rules.json) that the player proxy mounts at
 * /etc/player-proxy/rules/rules.json. kubelet re-syncs mounted ConfigMap
 * files within ~60s, so an edit here reaches the service worker WITHOUT a
 * helm upgrade or pod restart.
 *
 * Uses the in-cluster service account token to talk to the Kubernetes API.
 * When run outside a cluster (local testing) it falls back to a local
 * rules.json file.
 */
"use strict";

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8080);
const TOKEN = process.env.FILTER_TOKEN || ""; // empty = auth disabled
const CM_NAME = process.env.RULES_CONFIGMAP || "";
const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
const NS =
  process.env.NAMESPACE ||
  (fs.existsSync(`${SA}/namespace`)
    ? fs.readFileSync(`${SA}/namespace`, "utf8").trim()
    : "default");
const LOCAL_FILE =
  process.env.RULES_FILE || path.join(require("os").tmpdir(), "bakrim-rules.json");
const { resolveAllManga } = require("./allmanga");
const INDEX = fs.existsSync(path.join(__dirname, "index.html"))
  ? fs.readFileSync(path.join(__dirname, "index.html"))
  : Buffer.from("<h1>filter UI: index.html missing</h1>");

const inCluster = Boolean(
  process.env.KUBERNETES_SERVICE_HOST && CM_NAME && fs.existsSync(`${SA}/token`),
);

/* ---------------------------------------------------------------- k8s API */
function api(method, body, reqPath) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        host: process.env.KUBERNETES_SERVICE_HOST,
        port: process.env.KUBERNETES_SERVICE_PORT || "443",
        method,
        ca: fs.readFileSync(`${SA}/ca.crt`),
        timeout: 10000,
        path: reqPath || `/api/v1/namespaces/${NS}/configmaps/${CM_NAME}`,
        headers: {
          Authorization: `Bearer ${fs.readFileSync(`${SA}/token`, "utf8")}`,
          Accept: "application/json",
          ...(data
            ? {
                "Content-Type":
                  method === "PATCH"
                    ? "application/merge-patch+json"
                    : "application/json",
                "Content-Length": Buffer.byteLength(data),
              }
            : {}),
        },
      },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => {
          let json = {};
          try {
            json = JSON.parse(b || "{}");
          } catch {}
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("k8s api timeout")));
    if (data) req.write(data);
    req.end();
  });
}

/* The seed blocklist. The chart deliberately does NOT ship the rules
   ConfigMap anymore (GitOps: its value is owned by the /filter page at
   runtime, and ArgoCD renders with `helm template`, where lookup is empty
   and every sync would wipe live edits) — so on a fresh cluster THIS
   service creates the ConfigMap from this list on first access. */
const DEFAULT_RULES = [
  "apiguinee.org",
  "benchform.org",
  "biomanos.org",
  "static.nresystems.com",
  "cdn.show-sb.com",
  "cdn.holdbitter.com",
  "mamshirt.com",
  "portalfluently.com",
  "crdcntrl.net",
  "dtscout.com",
  "adsco.re",
  "bvtpk.com",
  "rtmark.net",
  "b7510.com",
  "unbrownunflat.com",
  "malocacomals.com",
  "sixmossin.com",
  "realizationnewestfangs.com",
  "acscdn.com",
  "taloseempest.com",
  "profitableratecpm.com",
  "preferencenail.com",
  "protrafficinspector.com",
  "histats.com",
  "weirdopt.com",
  "kettledroopingcontinuation.com",
  "wayfarerorthodox.com",
  "woxaglasuy.net",
  "adeptspiritual.com",
  "calculating-laugh.com",
  "amavhxdlofklxjg.xyz",
  "usrpubtrk.com",
  "adexchangeclear.com",
  "cloudnestra.com",
  "neonhorizonworkshops.com",
  "googletagmanager.com",
  "google-analytics.com",
  "doubleclick.net",
  "googlesyndication.com",
  "yandex.ru",
  "trip.com",
  "wps.com",
  "casinokenta.sbs",
  "casinowilhelm.online",
  "desylunfeel.cfd",
];

async function readRules() {
  if (inCluster) {
    let r = await api("GET");
    if (r.status === 404) {
      // First run on a fresh cluster: create the ConfigMap from the seed.
      r = await api(
        "POST",
        {
          metadata: { name: CM_NAME },
          data: { "rules.json": JSON.stringify(DEFAULT_RULES) },
        },
        `/api/v1/namespaces/${NS}/configmaps`,
      );
      if (r.status !== 201) throw new Error(`configmap CREATE → ${r.status}`);
      return DEFAULT_RULES.slice();
    }
    if (r.status !== 200) throw new Error(`configmap GET → ${r.status}`);
    try {
      const j = JSON.parse((r.json.data && r.json.data["rules.json"]) || "[]");
      return Array.isArray(j) ? j : [];
    } catch {
      return [];
    }
  }
  try {
    const j = JSON.parse(fs.readFileSync(LOCAL_FILE, "utf8"));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

async function writeRules(list) {
  const s = JSON.stringify(list);
  if (inCluster) {
    const r = await api("PATCH", { data: { "rules.json": s } });
    if (r.status !== 200 && r.status !== 201)
      throw new Error(`configmap PATCH → ${r.status}`);
  } else {
    fs.writeFileSync(LOCAL_FILE, s);
  }
}

/* -------------------------------------------------------------- validation */
function normalizeHost(raw) {
  let h = String(raw || "").trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(h)) h = new URL(h).hostname;
  } catch {}
  h = h
    .replace(/^https?:\/\//, "")
    .split("/")[0]
    .split(":")[0]
    .replace(/^\*\.+/, "")
    .replace(/^\.+/, "");
  if (h.length > 253) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(h))
    return null;
  return h;
}

/* ---------------------------------------------------------------- helpers */
function send(res, status, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(status, {
    "Content-Type": type || "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => {
      b += c;
      if (b.length > 65536) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}

/* ------------------------------------------------------- allmanga web paths */
/* The desktop app resolves AllManga in the Electron main process; the website
 * build calls these instead (same-origin → no CORS, and the server can set the
 * Referer/Origin headers allanime requires, which a browser never may). */

function buildPlayerHtml(videoUrl, startTime, ref) {
  // Same player page Electron's local server served, but media goes through
  // the chart's /v/ proxy instead of a localhost /proxy route. First path
  // segment is the referer's DOMAIN — /v/<ref-host>/<host>/<path> — so HLS
  // relative segment URLs resolve against the same prefix and keep the
  // Referer (nginx sends it; JS cannot: Referer is a forbidden header).
  const isM3u8 = videoUrl.includes(".m3u8");
  const referer = ref || "https://allmanga.to";
  let proxied;
  try {
    const refHost = new URL(referer).hostname;
    const u = new URL(videoUrl);
    proxied = `/v/${refHost}/${u.host}${u.pathname}${u.search}`;
  } catch {
    proxied = "";
  }
  const t = Number(startTime) || 0;
  const safeSrc = JSON.stringify(proxied);
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;background:#000;overflow:hidden}video{width:100%;height:100%;object-fit:contain;display:block}</style>
</head><body>
<video id="v" src="${isM3u8 ? "" : proxied}" autoplay controls playsinline crossorigin="anonymous"></video>
${
  isM3u8
    ? `
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"></script>
<script>
  const video=document.getElementById('v');
  const src=${safeSrc};
  const startTime=${t};
  const refHost=${JSON.stringify(
    (() => {
      try {
        return new URL(referer).hostname;
      } catch {
        return "allmanga.to";
      }
    })(),
  )};
  // Absolute playlist/segment URLs point at foreign CDN hosts (often a
  // different one per playlist) — fetch them through /v/ too, so nginx sends
  // the embed Referer and the request stays same-origin (no CORS question).
  function toV(raw){
    try{
      const u=new URL(raw,location.href);
      if(u.origin!==location.origin)return '/v/'+refHost+'/'+u.host+u.pathname+u.search;
      return u.href;
    }catch{return raw;}
  }
  class VLoader extends Hls.DefaultConfig.loader{
    load(ctx,cfg,cb){ctx.url=toV(ctx.url);super.load(ctx,cfg,cb);}
  }
  if(Hls.isSupported()){
    const hls=new Hls({loader:VLoader});
    hls.loadSource(src);hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED,()=>{if(startTime>0)video.currentTime=startTime;video.play().catch(()=>{});});
  }else if(video.canPlayType('application/vnd.apple.mpegurl')){
    video.src=src;
    if(startTime>0)video.addEventListener('loadedmetadata',()=>{video.currentTime=startTime;},{once:true});
  }
</script>`
    : t > 0
      ? `<script>
  const v=document.getElementById('v');
  v.addEventListener('loadedmetadata',()=>{v.currentTime=${t};},{once:true});
</script>`
      : ""
}
</body></html>`;
}

/* ----------------------------------------------------------------- server */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://x");
    const p = url.pathname.replace(/\/+$/, "") || "/";

    if (p === "/healthz") return send(res, 200, "ok\n", "text/plain");
    if (p === "/filter")
      return send(res, 200, INDEX, "text/html; charset=utf-8");
    // the admin page is ONLY ever served under /filter — bounce stray root hits
    if (p === "/") {
      res.writeHead(302, { Location: "/filter" });
      return res.end();
    }

    // AllManga resolve — no token: playback must work without a prompt.
    // The 50s race keeps us under the ingress 60s proxy-read-timeout so the
    // UI gets a JSON error instead of a 504 page.
    if (p === "/am/resolve" && req.method === "GET") {
      const u = new URL(req.url, "http://x");
      const result = await Promise.race([
        resolveAllManga({
          title: u.searchParams.get("title") || "",
          seasonNumber: Number(u.searchParams.get("season") || 1) || 1,
          episodeNumber: Number(u.searchParams.get("ep") || 1) || 1,
          isMovie: u.searchParams.get("movie") === "1",
          translationType: u.searchParams.get("tr") === "dub" ? "dub" : "sub",
        }),
        new Promise((r) =>
          setTimeout(
            () => r({ ok: false, error: "AllManga resolver timed out" }),
            50000,
          ),
        ),
      ]);
      return send(res, 200, JSON.stringify(result));
    }

    // The iframe player page for a resolved stream (web-build AllManga).
    if (p === "/am/player" && req.method === "GET") {
      const u = new URL(req.url, "http://x");
      const videoUrl = u.searchParams.get("u") || "";
      if (!/^https?:\/\//.test(videoUrl))
        return send(res, 400, JSON.stringify({ error: "missing u" }));
      const html = buildPlayerHtml(
        videoUrl,
        u.searchParams.get("t") || "0",
        u.searchParams.get("ref") || "",
      );
      return send(res, 200, html, "text/html; charset=utf-8");
    }

    if (p === "/filter/api/rules") {
      const authed = !TOKEN || req.headers["x-filter-token"] === TOKEN;
      if (!authed) return send(res, 401, JSON.stringify({ error: "bad token" }));

      if (req.method === "GET") {
        return send(res, 200, JSON.stringify({ rules: await readRules() }));
      }
      if (req.method === "POST" || req.method === "DELETE") {
        const body = await readBody(req);
        const host = normalizeHost(body.host);
        if (!host)
          return send(
            res,
            400,
            JSON.stringify({ error: "not a valid domain: " + String(body.host) }),
          );
        const list = await readRules();
        let updated = list;
        if (req.method === "POST") {
          if (!list.includes(host)) {
            list.push(host);
            list.sort();
            await writeRules(list);
          }
        } else {
          updated = list.filter((h) => h !== host);
          await writeRules(updated);
        }
        // return the POST-change list so the UI renders the actual state
        return send(res, 200, JSON.stringify({ rules: updated }));
      }
      return send(res, 405, JSON.stringify({ error: "method not allowed" }));
    }

    return send(res, 404, JSON.stringify({ error: "not found" }));
  } catch (e) {
    return send(res, 500, JSON.stringify({ error: String((e && e.message) || e) }));
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[filter-ui] :${PORT} mode=${inCluster ? "cluster(ns=" + NS + ", cm=" + CM_NAME + ")" : "local-file"}` +
      ` auth=${TOKEN ? "token" : "disabled"}`,
  );
});
