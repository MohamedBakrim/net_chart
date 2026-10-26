/* AllManga resolver — hianime.at pipeline (the provider ani-cli v5 uses).
 *
 * Replaces the old AllAnime (api.allanime.day) flow: upstream now rejects it
 * with AA_CRYPTO_MISSING behind rotating keys/captcha (ani-cli issue #1806),
 * so allmanga.to's source API is dead — this module scrapes hianime.at instead,
 * exactly like ani-cli 5.1.6:
 *   1. GET /search?keyword=…            → show slug + title
 *   2. GET /api/theme/episode/list/<id> → data-number + data-id per episode
 *   3. GET /api/theme/episode/servers?episodeId=… → ZokoAnime embed (base64)
 *   4. GET <embed> → window.__P blob → base64 → XOR "otaku-embed-v1" → JSON
 *      { src: <master m3u8>, subtitles: [...] }
 * The media is HLS; /am/player plays it with hls.js through the chart's /v/
 * proxy, which sends the embed-origin Referer the CDN checks.
 *
 * Export shape is unchanged from the Electron handler, so MoviePage/TVPage
 * consume it identically on both builds: { ok, url, isDirectMp4, referer, … }.
 */
"use strict";

const https = require("https");

const FIREFOX_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0";
const BASE = "https://hianime.at";
const EMBED_BLOB_KEY = "otaku-embed-v1"; // XOR key of window.__P (ani-cli v5)

/* ── HTTP helper: GET with UA, follows a few redirects ─────────────────────── */

function httpGet(urlStr, referer, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      return reject(new Error("invalid url"));
    }
    const headers = {
      "User-Agent": FIREFOX_UA,
      Accept: "text/html,application/xhtml+xml,application/json,*/*",
    };
    if (referer) headers.Referer = referer;
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (hops >= 5) return reject(new Error("too many redirects"));
          const loc = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, urlStr).href;
          return resolve(httpGet(loc, referer, hops + 1));
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(12000, () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/* ── 1. search ─────────────────────────────────────────────────────────────── */
/* Returns [{ slug, name }] in relevance order (sidebar duplicates removed). */

function parseSearch(html) {
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="[^"]*\/watch\/([^"/?]+)"[^>]*title="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    const slug = m[1];
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, name: decodeEntities(m[2]) });
  }
  return out;
}

/* ── 2. episode list ───────────────────────────────────────────────────────── */
/* numericId = slug tail after the last "-" (ani-cli: ${1##*-}).
 * Returns [{ ep, id }] in list order. */

async function episodeList(slug) {
  const numericId = slug.slice(slug.lastIndexOf("-") + 1);
  const res = await httpGet(`${BASE}/api/theme/episode/list/${numericId}`);
  if (res.status !== 200) return null;
  let html;
  try {
    const json = JSON.parse(res.body);
    if (!json.status || !json.html) return null;
    html = json.html;
  } catch {
    return null;
  }
  const out = [];
  const re = /data-number="([^"]+)"[\s\S]{0,400}?data-id="([0-9]+)"/g;
  let m;
  while ((m = re.exec(html))) out.push({ ep: m[1], id: m[2] });
  return out.length ? out : null;
}

function pickEpisode(list, want /* string, e.g. "12" */) {
  if (!list) return null;
  const hit = list.find((e) => e.ep === want);
  if (hit) return hit;
  const n = Number(want);
  if (Number.isFinite(n))
    return list.find((e) => Math.abs(Number(e.ep) - n) < 0.001) || null;
  return null;
}

/* ── 3. servers → ZokoAnime embed ──────────────────────────────────────────── */
/* Each server item is a chunk containing data-type / data-server-name / data-hash.
 * Only ZokoAnime ships the __P blob format deobfuscation understands (ani-cli). */

async function serverEmbed(episodeId, mode /* "sub" | "dub" */) {
  const res = await httpGet(
    `${BASE}/api/theme/episode/servers?episodeId=${encodeURIComponent(episodeId)}`,
  );
  if (res.status !== 200) return null;
  let html;
  try {
    const json = JSON.parse(res.body);
    if (!json.status || !json.html) return null;
    html = json.html;
  } catch {
    return null;
  }
  const chunks = html.split(/server-item/);
  for (const c of chunks) {
    if (!c.includes(`data-type="${mode}"`)) continue;
    if (!c.includes('data-server-name="ZokoAnime"')) continue;
    const hash = c.match(/data-hash="([^"]+)"/);
    if (!hash) continue;
    try {
      return Buffer.from(hash[1], "base64").toString("utf8");
    } catch {
      return null;
    }
  }
  return null;
}

/* ── 4. embed page → deobfuscated config ───────────────────────────────────── */

function xorDeobfuscate(b64) {
  try {
    const bytes = Buffer.from(b64, "base64");
    const key = Buffer.from(EMBED_BLOB_KEY, "ascii");
    const out = Buffer.allocUnsafe(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key[i % key.length];
    return out.toString("utf8");
  } catch {
    return null;
  }
}

async function embedConfig(embedUrl) {
  const res = await httpGet(embedUrl);
  if (res.status !== 200) return null;
  const m = res.body.match(/window\.__P="([^"]+)"/);
  if (!m) return null;
  const json = xorDeobfuscate(m[1]);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/* ── Title / season helpers (provider-agnostic, from the old resolver) ─────── */

function sanitizeTitle(t) {
  return t
    .replace(/[''`´]/g, "")
    .replace(/[:!.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// AniList: resolve the correct season title for S2+ and the season's episode
// total (so an episode past the end rolls into the sequel's numbering).
function anilistSeasonTitle(baseTitle, seasonNumber) {
  return new Promise((resolve) => {
    const resolveS1 = seasonNumber <= 1;
    const query = `query($search:String){Media(search:$search,type:ANIME,sort:SEARCH_MATCH){title{english romaji}episodes relations{edges{relationType node{type format title{english romaji}episodes startDate{year}seasonYear}}}}}`;
    const body = JSON.stringify({ query, variables: { search: baseTitle } });
    const opts = {
      hostname: "graphql.anilist.co",
      path: "/",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const fallback = {
      title: baseTitle,
      romaji: null,
      episodes: null,
      nextTitle: null,
      nextRomaji: null,
    };

    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const media = json?.data?.Media;
          if (!media) return resolve(fallback);

          const s1Romaji = media?.title?.romaji || null;
          const s1Episodes = media?.episodes || null;
          const sequels = (media.relations?.edges || [])
            .filter(
              (e) =>
                e.relationType === "SEQUEL" &&
                e.node.type === "ANIME" &&
                (e.node.format === "TV" || e.node.format === "TV_SHORT"),
            )
            .sort((a, b) => {
              const ya = a.node.startDate?.year || a.node.seasonYear || 9999;
              const yb = b.node.startDate?.year || b.node.seasonYear || 9999;
              return ya - yb;
            });

          const getTitle = (node) =>
            node.title?.english || node.title?.romaji || null;
          const getRomaji = (node) => node.title?.romaji || null;

          if (resolveS1) {
            const next = sequels[0]?.node ?? null;
            return resolve({
              title: media.title?.english || baseTitle,
              romaji: s1Romaji,
              episodes: s1Episodes,
              nextTitle: next ? getTitle(next) : null,
              nextRomaji: next ? getRomaji(next) : null,
            });
          }

          const target = sequels[seasonNumber - 2];
          if (!target) return resolve({ ...fallback, romaji: s1Romaji });

          const nextNode = sequels[seasonNumber - 1]?.node ?? null;
          resolve({
            title: getTitle(target.node) || baseTitle,
            romaji: getRomaji(target.node) || s1Romaji,
            episodes: target.node.episodes || null,
            nextTitle: nextNode ? getTitle(nextNode) : null,
            nextRomaji: nextNode ? getRomaji(nextNode) : null,
          });
        } catch {
          resolve(fallback);
        }
      });
    });
    req.on("error", () => resolve(fallback));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve(fallback);
    });
    req.write(body);
    req.end();
  });
}

/* ── The resolver (drop-in for the ipcMain "resolve-allmanga" handler) ─────── */

async function resolveAllManga({
  title,
  seasonNumber,
  episodeNumber,
  isMovie,
  translationType,
}) {
  try {
    const season = seasonNumber || 1;
    const mode = translationType === "dub" ? "dub" : "sub";

    // AniList season title lookup (+ episode remap when a TMDB season runs
    // past what AniList counts, i.e. it spilled into the sequel).
    const anilistResult = isMovie
      ? {
          title,
          romaji: null,
          episodes: null,
          nextTitle: null,
          nextRomaji: null,
        }
      : await anilistSeasonTitle(title, season);

    let searchTitle = anilistResult.title;
    let adjustedEpisodeNumber = episodeNumber;

    if (
      !isMovie &&
      anilistResult.episodes &&
      episodeNumber > anilistResult.episodes &&
      anilistResult.nextTitle
    ) {
      adjustedEpisodeNumber = episodeNumber - anilistResult.episodes;
      searchTitle = anilistResult.nextTitle;
    }

    const epStr = isMovie ? "1" : String(adjustedEpisodeNumber);

    // Candidate titles: exact → sanitized → romaji → base title.
    const candidateSet = new Set([
      searchTitle,
      sanitizeTitle(searchTitle),
      ...(anilistResult.romaji && searchTitle === anilistResult.title
        ? [anilistResult.romaji]
        : []),
      ...(anilistResult.nextRomaji && searchTitle === anilistResult.nextTitle
        ? [anilistResult.nextRomaji]
        : []),
      title,
      sanitizeTitle(title),
    ]);
    const candidates = [...candidateSet].filter(Boolean);

    // Search hianime for the first candidate that returns hits.
    let matches = null;
    let matchedTitle = searchTitle;
    for (const candidate of candidates) {
      const res = await httpGet(
        `${BASE}/search?keyword=${encodeURIComponent(candidate)}`,
      ).catch(() => null);
      const hits = res?.status === 200 ? parseSearch(res.body) : [];
      if (hits.length) {
        matches = hits;
        matchedTitle = candidate;
        break;
      }
    }
    if (!matches?.length)
      return { ok: false, error: "No results for: " + searchTitle };

    const want = matchedTitle.toLowerCase().trim();
    const show =
      matches.find((e) => e.name.toLowerCase().trim() === want) ||
      matches.find((e) => e.name.toLowerCase().includes(want)) ||
      matches[0];

    // Episode id → ZokoAnime embed → m3u8 config.
    const eps = await episodeList(show.slug).catch(() => null);
    const epEntry = pickEpisode(eps, epStr);
    if (!epEntry)
      return { ok: false, error: "Episode " + epStr + " not listed" };

    const embedUrl = await serverEmbed(epEntry.id, mode).catch(() => null);
    if (!embedUrl)
      return { ok: false, error: "No ZokoAnime server for ep " + epStr };

    const cfg = await embedConfig(embedUrl).catch(() => null);
    if (!cfg?.src)
      return { ok: false, error: "Embed did not expose a stream" };

    let referer;
    try {
      referer = new URL(embedUrl).origin + "/";
    } catch {
      referer = "https://allmanga.to";
    }

    return {
      ok: true,
      url: cfg.src,
      resolution: "?",
      sourceName: "hianime/" + mode,
      isDirectMp4: false, // HLS → /am/player plays it with hls.js
      referer,
      searchTitle,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { resolveAllManga };
