'use strict';
/* global VG */

const EXT_ORIGIN = browser.runtime.getURL('');
const CONCURRENCY = 6;
const MIN_FILE_SIZE = 1.5e6;

const tabs = new Map(); // tabId -> { items: Map<key,item>, children: Set<url>, segDirs: Set<dir>, dom: [] }
const jobs = new Map(); // jobId -> job
const hostReferer = new Map(); // host -> referer (dla zapytań wysyłanych przez rozszerzenie)

let seq = 0;
const uid = (p) => p + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortError = () => new DOMException('Anulowano', 'AbortError');

function tabState(tabId) {
  let t = tabs.get(tabId);
  if (!t) {
    t = { items: new Map(), children: new Set(), segDirs: new Set(), dom: [] };
    tabs.set(tabId, t);
  }
  return t;
}

// ---------------------------------------------------------------------------
// Referer / Origin dla własnych zapytań (część CDN odrzuca zapytania bez nich)
// ---------------------------------------------------------------------------
function registerReferer(url, referer) {
  if (!referer || !/^https?:/i.test(referer)) return;
  try {
    const host = new URL(url).host;
    if (!host) return;
    hostReferer.delete(host);
    hostReferer.set(host, referer);
    if (hostReferer.size > 500) hostReferer.delete(hostReferer.keys().next().value);
  } catch (e) {}
}

browser.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    if (d.tabId !== -1) return;
    if (d.originUrl && !d.originUrl.startsWith(EXT_ORIGIN)) return;
    let ref;
    try {
      ref = hostReferer.get(new URL(d.url).host);
    } catch (e) {}
    if (!ref) return;
    const hadOrigin = d.requestHeaders.some((h) => h.name.toLowerCase() === 'origin');
    const headers = d.requestHeaders.filter((h) => !/^(referer|origin)$/i.test(h.name));
    headers.push({ name: 'Referer', value: ref });
    if (hadOrigin) headers.push({ name: 'Origin', value: new URL(ref).origin });
    return { requestHeaders: headers };
  },
  { urls: ['<all_urls>'] },
  ['blocking', 'requestHeaders']
);

// ---------------------------------------------------------------------------
// Pobieranie danych
// ---------------------------------------------------------------------------
async function fetchText(url, referer, signal) {
  registerReferer(url, referer);
  const r = await fetch(url, { credentials: 'include', signal });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}

async function fetchBytes(url, range, referer, signal) {
  registerReferer(url, referer);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal && signal.aborted) throw abortError();
    try {
      const headers = {};
      if (range) headers.Range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
      const r = await fetch(url, { headers, credentials: 'include', signal });
      if (!r.ok) throw new Error('HTTP ' + r.status + ' – ' + url.split('?')[0].split('/').pop());
      let buf = new Uint8Array(await r.arrayBuffer());
      if (range && r.status === 200 && buf.length > range.length) buf = buf.slice(range.offset, range.offset + range.length);
      return buf;
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      lastErr = e;
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Pobiera fragment pliku (do sondowania nagłówków). Gdy serwer ignoruje Range — czyta tylko potrzebną część.
async function fetchRange(url, start, end, referer) {
  registerReferer(url, referer);
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, credentials: 'include' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  let total = 0;
  const cr = r.headers.get('content-range');
  const m = cr && /\/(\d+)/.exec(cr);
  if (m) total = +m[1];
  else if (r.status === 200) total = +(r.headers.get('content-length') || 0);
  const want = end - start + 1;
  const contentType = (r.headers.get('content-type') || '').toLowerCase();
  if (r.status === 206) return { bytes: new Uint8Array(await r.arrayBuffer()), total, contentType };
  // 200: serwer wysyła cały plik od początku
  const reader = r.body.getReader();
  const chunks = [];
  let got = 0;
  while (got < end + 1) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(got);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return { bytes: all.subarray(start, start + want), total, contentType };
}

// Rozpoznaje rodzaj adresu z listy M3U: hls / dash / file
async function sniffKind(url, referer) {
  const ext = VG.urlExt(url);
  if (ext === 'm3u8' || ext === 'm3u') return { kind: 'hls' };
  if (ext === 'mpd') return { kind: 'dash' };
  const r = await fetchRange(url, 0, 4095, referer);
  const head = new TextDecoder('utf-8').decode(r.bytes.subarray(0, 1024)).trimStart();
  if (r.contentType.includes('mpegurl') || head.startsWith('#EXTM3U')) return { kind: 'hls' };
  if (r.contentType.includes('dash+xml') || /<MPD[\s>]/.test(head)) return { kind: 'dash' };
  // brak całkowitej długości = strumień bez końca (radio, transmisja)
  return { kind: 'file', mime: r.contentType, size: r.total, live: !r.total };
}

// ---------------------------------------------------------------------------
// Wykrywanie wideo
// ---------------------------------------------------------------------------
function hdr(d, name) {
  const h = (d.responseHeaders || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

function totalSize(d) {
  const m = /\/(\d+)/.exec(hdr(d, 'content-range'));
  if (m) return +m[1];
  if (d.statusCode === 200) return +hdr(d, 'content-length') || 0;
  return 0;
}

function normKey(url) {
  try {
    const u = new URL(url);
    for (const p of ['range', 'bytestart', 'byteend', 'rn', 'rbuf', 'start', 'end']) u.searchParams.delete(p);
    u.hash = '';
    return u.href;
  } catch (e) {
    return url;
  }
}

const dirOf = (url) => url.split('?')[0].replace(/[^/]*$/, '');

browser.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400) return;
    let p;
    try {
      const u = new URL(d.url);
      if (/(^|\.)googlevideo\.com$/.test(u.hostname)) return; // YouTube – obsługiwany osobno
      p = u.pathname.toLowerCase();
    } catch (e) {
      return;
    }
    const ct = hdr(d, 'content-type').toLowerCase();
    const referer = d.documentUrl || d.originUrl || '';
    if (/\.m3u8?$/.test(p) || ct.includes('mpegurl')) return void addItem(d.tabId, 'hls', d.url, { referer });
    if (/\.mpd$/.test(p) || ct.includes('dash+xml')) return void addItem(d.tabId, 'dash', d.url, { referer });

    const extOk = /\.(mp4|webm|mov|mkv|m4v|ogv)$/.test(p);
    if (!ct.startsWith('video/') && !extOk) return;
    if (/\.(m4s|ts|cmfv|cmfa|m4a|aac|m4f)$/.test(p) || ct.includes('mp2t')) return;
    if (ct && !ct.startsWith('video/') && !/octet-stream|binary/.test(ct)) return;
    if (/\/(seg|segment|chunk|frag|fragment)[-_]?\d+/i.test(p)) return;
    const size = totalSize(d);
    if (size && size < MIN_FILE_SIZE) return;
    addItem(d.tabId, 'file', d.url, { referer: d.type === 'main_frame' ? '' : referer, size, mime: ct });
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

browser.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  const t = tabs.get(d.tabId);
  if (!t) return;
  for (const [k, it] of t.items) if (it.url !== d.url) t.items.delete(k);
  t.children.clear();
  t.segDirs.clear();
  t.dom = [];
  updateBadge(d.tabId);
});

browser.tabs.onRemoved.addListener((tabId) => tabs.delete(tabId));

function updateBadge(tabId) {
  const t = tabs.get(tabId);
  const n = t ? [...t.items.values()].filter((i) => i.status !== 'error').length : 0;
  browser.browserAction.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
}
browser.browserAction.setBadgeBackgroundColor({ color: '#2b6cff' });

async function addItem(tabId, kind, url, extra = {}) {
  const t = tabState(tabId);
  const key = kind === 'file' ? normKey(url) : url;
  if (t.items.has(key) || t.children.has(url)) return;
  if (kind === 'file' && [...t.segDirs].some((dir) => url.startsWith(dir))) return;
  const item = {
    id: uid('i'),
    key,
    kind,
    url,
    tabId,
    status: 'parsing',
    error: '',
    title: '',
    pageUrl: '',
    referer: extra.referer || '',
    size: extra.size || 0,
    mime: extra.mime || '',
    duration: 0,
    live: !!extra.live,
    drm: false,
    notes: [],
    options: [],
    created: Date.now(),
  };
  t.items.set(key, item);
  updateBadge(tabId);
  try {
    const tab = await browser.tabs.get(tabId);
    item.title = tab.title || '';
    item.pageUrl = tab.url || '';
  } catch (e) {}
  if (extra.title) item.title = extra.title;
  if (!item.referer) item.referer = /^https?:/.test(item.pageUrl) && item.pageUrl !== url ? item.pageUrl : '';
  registerReferer(url, item.referer);
  try {
    if (kind === 'hls') await analyzeHls(item, t);
    else if (kind === 'dash') await analyzeDash(item, t);
    else await analyzeFile(item, t);
    item.status = 'ready';
  } catch (e) {
    item.status = 'error';
    item.error = String((e && e.message) || e);
  }
  fillFromDom(t);
  updateBadge(tabId);
}

function markChild(t, url) {
  t.children.add(url);
  for (const [k, it] of t.items) if (it.kind === 'hls' && it.url === url) t.items.delete(k);
}

function addSegDir(t, url) {
  if (!url) return;
  const dir = dirOf(url);
  if (dir.split('/').length < 5) return; // nie blokuj całych domen
  t.segDirs.add(dir);
  for (const [k, it] of t.items) if (it.kind === 'file' && it.url.startsWith(dir)) t.items.delete(k);
}

function sortOptions(opts) {
  return opts.sort((a, b) => {
    if (!!a.audioOnly !== !!b.audioOnly) return a.audioOnly ? 1 : -1;
    return (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0);
  });
}

const hlsTrackKey = (a) => (a.language || '') + '|' + (a.name || '');

function hlsAudioTracks(list) {
  const map = new Map();
  for (const a of list) {
    const k = hlsTrackKey(a);
    const tr = map.get(k) || {
      id: k,
      label:
        (a.name || a.language || 'Audio') +
        (a.language && a.name && !a.name.includes(a.language) ? ` (${a.language})` : '') +
        (a.channels ? ` · ${a.channels} kan.` : ''),
      isDefault: false,
    };
    if (a.isDefault) tr.isDefault = true;
    map.set(k, tr);
  }
  const out = [...map.values()];
  return out.length > 1 ? out.sort((x, y) => (y.isDefault ? 1 : 0) - (x.isDefault ? 1 : 0)) : [];
}

async function analyzeHls(item, t) {
  const text = await fetchText(item.url, item.referer);
  if (!VG.hls.isHls(text)) {
    // Zwykła lista M3U (kanały IPTV, radio) – nie sklejamy jej, tylko pokazujemy pozycje do analizy
    const entries = VG.hls.parsePlain(text, item.url);
    if (!entries.length) throw new Error('To nie jest playlista HLS ani lista M3U');
    item.kind = 'm3u';
    item.entries = entries.map((e, i) => ({ id: 'e' + i, ...e, added: false }));
    item.notes.push(`Lista M3U (${entries.length} poz.) – wybierz pozycję i kliknij „Analizuj”, żeby zobaczyć jakości i pobrać.`);
    return;
  }

  if (VG.hls.isMaster(text)) {
    const m = VG.hls.parseMaster(text, item.url);
    for (const v of m.variants) markChild(t, v.url);
    for (const a of m.audio) if (a.url) markChild(t, a.url);
    for (const x of m.subs) markChild(t, x.url);
    item._hls = { audio: m.audio.filter((a) => a.url), subs: m.subs };
    item.audioTracks = hlsAudioTracks(item._hls.audio);
    item.subTracks = m.subs.map((x, i) => ({
      id: 'h' + i,
      label: (x.name || x.language || 'Napisy ' + (i + 1)) + (x.language && x.name && !x.name.includes(x.language) ? ` (${x.language})` : ''),
      _url: x.url,
      _lang: x.language,
    }));

    const audioFor = (group) => {
      const list = m.audio.filter((a) => a.groupId === group && a.url);
      return list.find((a) => a.isDefault) || list[0] || null;
    };
    item.options = m.variants.map((v) => {
      const audioOnly = !v.width && VG.isAudioOnlyCodecs(v.codecs);
      const audio = v.audioGroup ? audioFor(v.audioGroup) : null;
      return {
        id: uid('o'),
        label: audioOnly ? 'Audio' : VG.qualityLabel(v.width, v.height),
        width: v.width,
        height: v.height,
        fps: v.fps,
        bandwidth: v.avgBandwidth || v.bandwidth,
        codecs: v.codecs,
        audioOnly,
        hdr: audioOnly
          ? null
          : VG.classifyHdr({ codecs: v.codecs, videoRange: v.videoRange, supplementalCodecs: v.supplementalCodecs }),
        audio: audio && audio.url !== v.url ? { name: audio.name, language: audio.language, channels: audio.channels } : null,
        _hlsVideo: v.url,
        _hlsAudio: audio && audio.url !== v.url ? audio.url : null,
        _hlsGroup: v.audioGroup,
      };
    });
    // Samo audio (z grupy domyślnej)
    if (m.audio.length && !item.options.some((o) => o.audioOnly)) {
      const a = m.audio.find((x) => x.isDefault && x.url) || m.audio.find((x) => x.url);
      if (a) {
        item.options.push({
          id: uid('o'),
          label: 'Audio',
          audioOnly: true,
          codecs: '',
          audio: { name: a.name, language: a.language, channels: a.channels },
          _hlsVideo: a.url,
          _hlsAudio: null,
          _hlsAudioOnlyRendition: true,
        });
      }
    }
    sortOptions(item.options);
    // Sprawdź najlepszy wariant: długość, DRM, transmisja na żywo
    const best = item.options.find((o) => !o.audioOnly) || item.options[0];
    if (best) {
      try {
        const mp = VG.hls.parseMedia(await fetchText(best._hlsVideo, item.referer), best._hlsVideo);
        item.duration = mp.totalDuration;
        item.live = !mp.endList;
        item.drm = mp.drm;
        addSegDir(t, mp.segments[0] && mp.segments[0].url);
        if (!best.width && mp.segments[0] && mp.segments[0].map) await probeInit(best, mp.segments[0].map, item);
      } catch (e) {}
    }
  } else {
    if (t.children.has(item.url)) throw new Error('Wariant innej playlisty');
    const mp = VG.hls.parseMedia(text, item.url);
    if (!mp.segments.length) throw new Error('Pusta playlista');
    item.duration = mp.totalDuration;
    item.live = !mp.endList;
    item.drm = mp.drm;
    addSegDir(t, mp.segments[0].url);
    const opt = { id: uid('o'), label: '?', width: 0, height: 0, codecs: '', hdr: VG.classifyHdr({}), _hlsVideo: item.url, _hlsAudio: null };
    if (mp.segments[0].map) await probeInit(opt, mp.segments[0].map, item);
    item.options = [opt];
  }
  if (item.drm) item.notes.push('Zabezpieczone DRM – pobranie niemożliwe.');
  if (item.live) item.notes.push('Transmisja na żywo – zostanie pobrany tylko bieżący fragment.');
}

// Odczyt segmentu inicjalizującego fMP4 (rozdzielczość, HDR)
async function probeInit(opt, map, item) {
  try {
    const bytes = await fetchBytes(map.url, map.range, item.referer);
    let off = 0;
    while (off + 8 <= bytes.length) {
      const size = ((bytes[off] << 24) >>> 0) + (bytes[off + 1] << 16) + (bytes[off + 2] << 8) + bytes[off + 3];
      const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
      if (type === 'moov') {
        const info = VG.parseMoov(bytes.subarray(off, off + size));
        const v = info && info.video;
        if (v) {
          opt.width = opt.width || v.width;
          opt.height = opt.height || v.height;
          opt.label = VG.qualityLabel(opt.width, opt.height);
          if (!opt.codecs) opt.codecs = v.format;
          const h = VG.classifyHdr({ codecs: v.format, transfer: v.transfer, bitDepth: v.bitDepth, dolby: v.dolby, hdrMeta: v.hdrMeta, primaries: v.primaries, matrix: v.matrix });
          if (!opt.hdr || opt.hdr.isHdr === null || h.isHdr) opt.hdr = h;
        }
        break;
      }
      if (size < 8) break;
      off += size;
    }
  } catch (e) {}
}

async function analyzeDash(item, t) {
  const text = await fetchText(item.url, item.referer);
  const d = VG.dash.parse(text, item.url);
  item.duration = d.duration;
  item.live = d.dynamic;
  const audios = d.audios.filter((a) => !a.drm && a.seg).sort((a, b) => b.bandwidth - a.bandwidth);
  // ścieżki dźwiękowe: język + etykieta + rola; w każdej grupie najwyższy bitrate
  const groups = new Map();
  for (const a of audios) {
    const k = (a.lang || '') + '|' + (a.label || '') + '|' + (a.role === 'main' || !a.role ? '' : a.role);
    if (!groups.has(k)) groups.set(k, a);
  }
  item._dashAudio = groups;
  item.audioTracks =
    groups.size > 1
      ? [...groups.entries()].map(([k, a]) => ({
          id: k,
          label:
            ([a.label, a.lang].filter(Boolean).join(' · ') || 'Audio') +
            (a.role && a.role !== 'main' ? ` (${a.role})` : '') +
            (a.channels ? ` · ${a.channels} kan.` : ''),
          isDefault: a === audios[0],
        }))
      : [];
  item.subTracks = d.texts
    .filter((x) => x.seg && !x.drm && (x.seg.single || /^text\//.test(x.mime)))
    .map((x, i) => ({
      id: 'd' + i,
      label: ([x.label, x.lang].filter(Boolean).join(' · ') || 'Napisy ' + (i + 1)) + (x.role && x.role !== 'subtitle' ? ` (${x.role})` : ''),
      _rep: x,
      _lang: x.lang,
    }));
  const bestAudio = audios[0] || d.audios[0] || null;
  item.options = d.videos.map((v) => ({
    id: uid('o'),
    label: VG.qualityLabel(v.width, v.height),
    width: v.width,
    height: v.height,
    fps: v.fps,
    bandwidth: v.bandwidth + (bestAudio ? bestAudio.bandwidth : 0),
    codecs: v.codecs + (bestAudio && bestAudio.codecs ? ',' + bestAudio.codecs : ''),
    hdr: VG.classifyHdr({ codecs: v.codecs, transfer: v.transfer }),
    drm: v.drm || (bestAudio && bestAudio.drm),
    audio: bestAudio ? { language: bestAudio.lang, channels: bestAudio.channels } : null,
    _video: v,
    _audio: bestAudio,
  }));
  if (bestAudio) {
    item.options.push({
      id: uid('o'),
      label: 'Audio',
      audioOnly: true,
      bandwidth: bestAudio.bandwidth,
      codecs: bestAudio.codecs,
      drm: bestAudio.drm,
      audio: { language: bestAudio.lang, channels: bestAudio.channels },
      _video: null,
      _audio: bestAudio,
    });
  }
  sortOptions(item.options);
  for (const r of [...d.videos, ...d.audios]) {
    if (r.seg && !r.seg.single) addSegDir(t, (r.seg.segments[0] || {}).url);
  }
  item.drm = item.options.length > 0 && item.options.every((o) => o.drm);
  if (item.drm) item.notes.push('Zabezpieczone DRM – pobranie niemożliwe.');
  else if (item.options.some((o) => o.drm)) item.notes.push('Część wersji jest zabezpieczona DRM.');
  if (item.live) item.notes.push('Transmisja na żywo (dynamic MPD) – pobieranie może być niepełne.');
  if (d.multiPeriod) item.notes.push('Manifest ma kilka okresów – pobierany jest tylko pierwszy.');
  if (d.videos.length && bestAudio) item.notes.push('Obraz i dźwięk zostaną zapisane jako osobne pliki.');
}

async function analyzeFile(item) {
  const ext = VG.urlExt(item.url);
  const opt = { id: uid('o'), label: '?', width: 0, height: 0, codecs: '', hdr: VG.classifyHdr({}), size: item.size };
  item.options = [opt];
  item.container = ['webm', 'mkv', 'mov', 'mp4', 'm4v', 'ogv'].includes(ext) ? ext : item.mime.includes('webm') ? 'webm' : 'mp4';
  if (item.live) item.notes.push('Strumień bez końca (na żywo) – pobieranie trwa, dopóki go nie anulujesz.');
  const audio = /^audio\//.test(item.mime) || ['mp3', 'aac', 'ogg', 'opus', 'flac', 'm4a'].includes(ext);
  if (audio) {
    // radio / plik audio: bez sondowania nagłówka (strumień na żywo by się nie skończył)
    const m = /mpeg|aac|ogg|opus|flac|mp4/.exec(item.mime) || [];
    item.container = { mpeg: 'mp3', aac: 'aac', ogg: 'ogg', opus: 'opus', flac: 'flac', mp4: 'm4a' }[m[0]] || ext || 'mp3';
    Object.assign(opt, { label: 'Audio', audioOnly: true, hdr: null, codecs: item.container });
    return;
  }
  if (item.live) return;
  let p = null;
  try {
    p = await VG.probeFile(item.url, (u, s, e) => fetchRange(u, s, e, item.referer));
  } catch (e) {
    item.notes.push('Nie udało się odczytać nagłówka pliku (' + e.message + ').');
  }
  if (!p) return;
  if (p.total) opt.size = item.size = p.total;
  if (p.container) item.container = p.container;
  item.duration = p.duration || 0;
  const v = p.video;
  if (v) {
    opt.width = v.width || 0;
    opt.height = v.height || 0;
    opt.label = VG.qualityLabel(opt.width, opt.height);
    opt.codecs = [v.format, ...(p.audio || [])].filter(Boolean).join(',');
    opt.hdr = VG.classifyHdr({ codecs: v.format, transfer: v.transfer, bitDepth: v.bitDepth, dolby: v.dolby, hdrMeta: v.hdrMeta, primaries: v.primaries, matrix: v.matrix });
    if (v.encrypted) {
      opt.drm = item.drm = true;
      item.notes.push('Plik zaszyfrowany (CENC) – po pobraniu nie da się go odtworzyć.');
    }
  }
}

function fillFromDom(t) {
  for (const it of t.items.values()) {
    if (it.options.length !== 1) continue;
    const o = it.options[0];
    if (o.width || o.audioOnly) continue;
    const match = t.dom.find((v) => v.src === it.url) || (it.kind !== 'file' && t.dom.length === 1 ? t.dom[0] : null);
    if (match && match.w) {
      o.width = match.w;
      o.height = match.h;
      o.label = VG.qualityLabel(o.width, o.height);
      o.fromPlayer = true;
    }
    if (!it.duration && match && match.duration) it.duration = match.duration;
  }
}

function onDomVideos(tabId, msg, sender) {
  const t = tabState(tabId);
  const vids = (msg.videos || []).filter((v) => v && v.src);
  t.dom = vids.filter((v) => v.w && v.h);
  for (const v of vids) {
    if (/^https?:/i.test(v.src)) addItem(tabId, 'file', v.src, { referer: sender.url });
  }
  fillFromDom(t);
}

// ---------------------------------------------------------------------------
// Pobieranie
// ---------------------------------------------------------------------------
function makeName(item, option, ext, suffix = '') {
  const base = VG.sanitizeFilename(item.title || VG.fileNameFromUrl(item.url) || 'video');
  const parts = [base];
  if (option.label && option.label !== '?') parts.push(option.label.replace(/\s*\(.*\)/, ''));
  if (option.hdr && option.hdr.isHdr) parts.push(option.hdr.short || 'HDR');
  return VG.sanitizeFilename(parts.join(' ') + suffix) + '.' + ext;
}

function updateProgress(job, counter) {
  job.progress = counter.total ? counter.done / counter.total : 0;
  const now = Date.now();
  if (!job._t) {
    job._t = now;
    job._b = job.bytes;
  } else if (now - job._t >= 1000) {
    job.speed = ((job.bytes - job._b) * 1000) / (now - job._t);
    job._t = now;
    job._b = job.bytes;
  }
}

async function waitDownload(id, job, trackProgress) {
  for (;;) {
    const [d] = await browser.downloads.search({ id });
    if (!d) throw new Error('Pobieranie zniknęło z listy');
    if (trackProgress) {
      job.bytes = d.bytesReceived;
      job.progress = d.totalBytes > 0 ? d.bytesReceived / d.totalBytes : 0;
      updateProgress(job, { done: d.bytesReceived, total: d.totalBytes > 0 ? d.totalBytes : 0 });
    }
    if (d.state === 'complete') return d;
    if (d.state === 'interrupted') throw new Error('Pobieranie przerwane: ' + (d.error || 'nieznany błąd'));
    if (job.ctrl.signal.aborted) {
      await browser.downloads.cancel(id).catch(() => {});
      throw abortError();
    }
    await sleep(500);
  }
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop();

async function browserDownload(url, filename, job, referer, trackProgress) {
  registerReferer(url, referer);
  let id;
  const opts = { url, filename, saveAs: false, conflictAction: 'uniquify' };
  try {
    id = await browser.downloads.download(referer ? { ...opts, headers: [{ name: 'Referer', value: referer }] } : opts);
  } catch (e) {
    id = await browser.downloads.download(opts);
  }
  job.downloadIds.push(id);
  const d = await waitDownload(id, job, trackProgress);
  const name = baseName(d.filename) || filename;
  job.files.push(name);
  return name;
}

async function saveBlob(blob, filename, job) {
  const url = URL.createObjectURL(blob);
  try {
    job.phase = 'Zapisywanie pliku';
    const id = await browser.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    job.downloadIds.push(id);
    const d = await waitDownload(id, job, false);
    const name = baseName(d.filename) || filename;
    job.files.push(name);
    return name;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

async function decryptAes(data, key, cache, referer, signal) {
  let k = cache.get(key.uri);
  if (!k) {
    k = (async () => {
      const raw = await fetchBytes(key.uri, null, referer, signal);
      if (raw.length !== 16) throw new Error('Nieprawidłowy klucz AES-128');
      return crypto.subtle.importKey('raw', raw, { name: 'AES-CBC' }, false, ['decrypt']);
    })();
    cache.set(key.uri, k);
  }
  const ck = await k;
  let iv;
  if (key.iv) iv = VG.hexToBytes(key.iv, 16);
  else {
    iv = new Uint8Array(16);
    let s = key.seq;
    for (let i = 15; i >= 8 && s > 0; i--) {
      iv[i] = s % 256;
      s = Math.floor(s / 256);
    }
  }
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, ck, data));
}

// Pobiera części równolegle, zapisuje w kolejności.
async function downloadParts(parts, sink, job, referer, counter) {
  const signal = job.ctrl.signal;
  const results = new Map();
  let next = 0;
  let writeIdx = 0;
  let writing = Promise.resolve();
  let failed = null;
  const drain = async () => {
    while (results.has(writeIdx)) {
      const d = results.get(writeIdx);
      results.delete(writeIdx);
      writeIdx++;
      await sink.write(d);
    }
  };
  const worker = async () => {
    while (!failed) {
      const i = next++;
      if (i >= parts.length) return;
      while (i - writeIdx > 32 && !failed) await sleep(50);
      if (failed) return;
      const p = parts[i];
      let data = await fetchBytes(p.url, p.range, referer, signal);
      if (p.key) data = await decryptAes(data, p.key, job.keyCache, referer, signal);
      results.set(i, data);
      counter.done++;
      job.bytes += data.length;
      updateProgress(job, counter);
      writing = writing.then(drain);
      await writing;
    }
  };
  const workers = Array.from({ length: Math.min(CONCURRENCY, parts.length) }, () =>
    worker().catch((e) => {
      failed = failed || e;
    })
  );
  await Promise.all(workers);
  await writing.catch((e) => {
    failed = failed || e;
  });
  if (failed) throw failed;
  if (writeIdx !== parts.length) throw new Error('Nie wszystkie segmenty zostały zapisane');
}

async function saveTrack(job, parts, filename, mime, referer, counter) {
  const sink = await VG.createSink(job.id + '-' + job.files.length);
  try {
    await downloadParts(parts, sink, job, referer, counter);
    const file = await sink.finish(mime);
    const name = await saveBlob(file, filename, job);
    await sink.cleanup();
    return name;
  } catch (e) {
    await sink.abort();
    throw e;
  }
}

function hlsParts(media) {
  const parts = [];
  let lastMap = '';
  for (const s of media.segments) {
    if (s.map) {
      const k = s.map.url + JSON.stringify(s.map.range);
      if (k !== lastMap) {
        parts.push({ url: s.map.url, range: s.map.range });
        lastMap = k;
      }
    }
    parts.push({ url: s.url, range: s.range, key: s.key && s.key.method === 'AES-128' ? s.key : null });
  }
  return parts;
}

function hlsExt(media, audio) {
  if (media.segments.some((s) => s.map)) return audio ? 'm4a' : 'mp4';
  const ext = VG.urlExt((media.segments[0] || {}).url || '');
  if (['aac', 'mp3', 'ac3', 'ec3'].includes(ext)) return ext;
  if (['mp4', 'm4s', 'm4v', 'm4a', 'cmfv', 'cmfa'].includes(ext)) return audio ? 'm4a' : 'mp4';
  return 'ts';
}

const MIME = { ts: 'video/mp2t', mp4: 'video/mp4', m4a: 'audio/mp4', webm: 'video/webm', aac: 'audio/aac', mp3: 'audio/mpeg' };

function ffmpegNote(files, out) {
  const q = (s) => '"' + s + '"';
  return `ffmpeg -i ${q(files[0])} -i ${q(files[1])} -c copy ${q(out)}`;
}

// Napisy: plik WebVTT/TTML w całości albo segmenty WebVTT sklejone w jeden plik
function joinVtt(chunks) {
  const dec = new TextDecoder('utf-8');
  let out = '';
  chunks.forEach((c, i) => {
    let txt = dec.decode(c).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (i > 0) {
      // usuń nagłówek WEBVTT (z X-TIMESTAMP-MAP itp.) kolejnych segmentów
      const m = /^WEBVTT[^\n]*\n(?:[^\n]+\n)*\n?/.exec(txt);
      if (m) txt = txt.slice(m[0].length);
    }
    if (out && !out.endsWith('\n\n')) out += '\n';
    out += txt;
  });
  return out;
}

async function downloadSubtitle(job, item, option, sub) {
  job.phase = 'Pobieranie napisów';
  const signal = job.ctrl.signal;
  let ext = 'vtt';
  let blob = null;
  if (sub._url) {
    // HLS: playlista z segmentami WebVTT
    const text = await fetchText(sub._url, item.referer, signal);
    if (!text.includes('#EXTM3U')) blob = new Blob([text], { type: 'text/vtt' });
    else {
      const chunks = [];
      for (const x of VG.hls.parseMedia(text, sub._url).segments) chunks.push(await fetchBytes(x.url, x.range, item.referer, signal));
      blob = new Blob([joinVtt(chunks)], { type: 'text/vtt' });
    }
  } else {
    const r = sub._rep;
    if (/ttml/.test(r.mime) || /stpp/.test(r.codecs)) ext = 'ttml';
    if (r.seg.single) {
      blob = new Blob([await fetchBytes(r.seg.segments[0].url, null, item.referer, signal)]);
    } else {
      const parts = (r.seg.init ? [r.seg.init] : []).concat(r.seg.segments);
      const chunks = [];
      for (const x of parts) chunks.push(await fetchBytes(x.url, x.range, item.referer, signal));
      blob = new Blob(ext === 'vtt' ? [joinVtt(chunks)] : chunks, { type: 'text/plain' });
    }
  }
  const lang = String(sub._lang || sub.label || 'napisy').replace(/[^\w-]+/g, '_').slice(0, 20);
  return saveBlob(blob, makeName(item, option, lang + '.' + ext), job);
}

async function runHls(job, item, option) {
  const signal = job.ctrl.signal;
  const tracks = [];
  const load = async (url, audio) => {
    const media = VG.hls.parseMedia(await fetchText(url, item.referer, signal), url);
    if (media.drm) throw new Error('Strumień zabezpieczony DRM – nie da się pobrać.');
    if (!media.segments.length) throw new Error('Pusta playlista');
    tracks.push({ audio, media, parts: hlsParts(media), ext: hlsExt(media, audio) });
  };
  job.phase = 'Wczytywanie playlisty';
  // wybrana ścieżka dźwiękowa
  let audioUrl = option._hlsAudio;
  let videoUrl = option._hlsVideo;
  if (job.choice.audio && item._hls) {
    const same = item._hls.audio.filter((a) => hlsTrackKey(a) === job.choice.audio);
    const pick = same.find((a) => a.groupId === option._hlsGroup) || same[0];
    if (pick) {
      if (option._hlsAudioOnlyRendition) videoUrl = pick.url;
      else if (option._hlsAudio) audioUrl = pick.url;
    }
  }
  await load(videoUrl, !!option.audioOnly);
  if (audioUrl) await load(audioUrl, true);
  const counter = { done: 0, total: tracks.reduce((s, t) => s + t.parts.length, 0) };
  const multi = tracks.length > 1;
  for (const t of tracks) {
    job.phase = multi ? (t.audio ? 'Pobieranie audio' : 'Pobieranie obrazu') : 'Pobieranie segmentów';
    const name = makeName(item, option, t.ext, multi && t.audio ? ' audio' : '');
    await saveTrack(job, t.parts, name, MIME[t.ext], item.referer, counter);
  }
  if (multi) job.note = ffmpegNote(job.files, makeName(item, option, 'mp4', ' merged'));
  else if (tracks[0].ext === 'ts')
    job.note = `ffmpeg -i "${job.files[0]}" -c copy "${job.files[0].replace(/\.ts$/, '.mp4')}"`;
  if (job.choice.subTrack) await downloadSubtitle(job, item, option, job.choice.subTrack);
}

async function runDash(job, item, option) {
  const tracks = [];
  if (option._video) tracks.push({ audio: false, rep: option._video });
  let audioRep = option._audio;
  if (job.choice.audio && item._dashAudio && item._dashAudio.has(job.choice.audio)) audioRep = item._dashAudio.get(job.choice.audio);
  if (audioRep) tracks.push({ audio: true, rep: audioRep });
  for (const t of tracks) {
    if (t.rep.drm) throw new Error('Strumień zabezpieczony DRM – nie da się pobrać.');
    if (!t.rep.seg) throw new Error(t.rep.segErr || 'Nieobsługiwany format segmentów');
  }
  const multi = tracks.length > 1;
  const counter = {
    done: 0,
    total: tracks.reduce((s, t) => s + (t.rep.seg.single ? 0 : t.rep.seg.segments.length + (t.rep.seg.init ? 1 : 0)), 0),
  };
  for (const t of tracks) {
    const webm = /webm/.test(t.rep.mime);
    const ext = webm ? 'webm' : t.audio ? 'm4a' : 'mp4';
    const name = makeName(item, option, ext, multi && t.audio ? ' audio' : '');
    job.phase = multi ? (t.audio ? 'Pobieranie audio' : 'Pobieranie obrazu') : 'Pobieranie';
    if (t.rep.seg.single) {
      await browserDownload(t.rep.seg.segments[0].url, name, job, item.referer, counter.total === 0 && !multi);
    } else {
      const parts = (t.rep.seg.init ? [t.rep.seg.init] : []).concat(t.rep.seg.segments);
      await saveTrack(job, parts, name, webm ? 'video/webm' : MIME[ext], item.referer, counter);
    }
  }
  if (multi) job.note = ffmpegNote(job.files, makeName(item, option, 'mp4', ' merged'));
  if (job.choice.subTrack) await downloadSubtitle(job, item, option, job.choice.subTrack);
}

async function runFile(job, item, option) {
  job.phase = 'Pobieranie (menedżer pobierania Firefoksa)';
  const ext = item.container || 'mp4';
  await browserDownload(item.url, makeName(item, option, ext), job, item.referer, true);
}

// ---------------------------------------------------------------------------
// Program pomocniczy (native messaging) + yt-dlp
// ---------------------------------------------------------------------------
const native = { port: null, state: 'unknown', info: null, error: '', lastTry: 0, waiters: [], infoReq: new Map() };

function nativeConnect() {
  if (native.port || native.state === 'ok' || Date.now() - native.lastTry < 4000) return;
  native.lastTry = Date.now();
  native.state = 'connecting';
  let port;
  try {
    port = browser.runtime.connectNative('tabvideograb');
  } catch (e) {
    native.state = 'missing';
    native.error = e.message;
    return;
  }
  native.port = port;
  port.onMessage.addListener(onNativeMessage);
  port.onDisconnect.addListener((p) => {
    const err = (p && p.error && p.error.message) || '';
    native.port = null;
    native.state = native.state === 'ok' ? 'unknown' : 'missing';
    native.error = err;
    for (const w of native.waiters) w(false);
    native.waiters = [];
    for (const cb of native.infoReq.values()) cb({ error: 'Program pomocniczy zakończył działanie' });
    native.infoReq.clear();
    for (const j of jobs.values()) {
      if (j.native && j.status === 'running') j.native.reject(new Error('Program pomocniczy zakończył działanie ' + err));
    }
  });
  port.postMessage({ cmd: 'ping' });
}

function nativeReady(timeout = 4000) {
  if (native.state === 'ok' && native.port) return Promise.resolve(true);
  nativeConnect();
  if (native.state === 'missing') return Promise.resolve(false);
  return new Promise((resolve) => {
    native.waiters.push(resolve);
    setTimeout(() => resolve(native.state === 'ok'), timeout);
  });
}

function onNativeMessage(m) {
  if (!m) return;
  if (m.type === 'pong') {
    native.state = 'ok';
    native.info = m;
    for (const w of native.waiters) w(true);
    native.waiters = [];
    // dociągnij listy formatów dla filmów wykrytych zanim pomocnik był dostępny
    for (const t of tabs.values()) for (const it of t.items.values()) if (it.kind === 'youtube') requestYtdlpInfo(it);
    return;
  }
  if (m.type === 'info') {
    const cb = native.infoReq.get(m.id);
    native.infoReq.delete(m.id);
    if (cb) cb(m);
    return;
  }
  const job = jobs.get(m.id);
  if (!job || !job.native) return;
  const n = job.native;
  switch (m.type) {
    case 'progress': {
      if (m.part !== n.lastPart) {
        n.base += n.lastDl;
        n.lastPart = m.part;
        n.lastDl = 0;
      }
      n.lastDl = m.downloaded || 0;
      job.bytes = n.base + n.lastDl;
      const frac = m.total ? Math.min(1, m.downloaded / m.total) : 0;
      job.progress = Math.min(0.99, (Math.min(m.part, n.parts) - 1 + frac) / n.parts);
      job.speed = m.speed || 0;
      job.phase = n.parts > 1 ? (m.part <= 1 ? 'Pobieranie obrazu' : 'Pobieranie dźwięku') : 'Pobieranie';
      job.phase += ' (yt-dlp)';
      break;
    }
    case 'phase':
      if (m.phase === 'auth') {
        // film wymaga zalogowania – yt-dlp startuje ponownie z ciasteczkami Firefoksa
        job.phase = 'Ponowna próba z logowaniem z Firefoksa';
        Object.assign(n, { lastPart: 1, base: 0, lastDl: 0 });
        job.progress = 0;
        job.bytes = 0;
        const it = findItemByJob(job);
        if (it) it.needsCookies = true;
      } else job.phase = 'Łączenie obrazu z dźwiękiem (ffmpeg)';
      job.speed = 0;
      break;
    case 'done':
      job.fullPaths = m.files || [];
      job.files = job.fullPaths.map(baseName);
      n.resolve();
      break;
    case 'error':
      n.reject(new Error(m.error || 'Błąd yt-dlp'));
      break;
    case 'canceled':
      n.reject(abortError());
      break;
  }
}

function findItemByJob(job) {
  const t = tabs.get(job.tabId);
  return t ? t.items.get(job.itemKey) : null;
}

function requestYtdlpInfo(item) {
  if (item.ytdlpPending || item.source === 'ytdlp' || native.state !== 'ok' || !native.port) return;
  if (!native.info || !native.info.ytdlp) return;
  item.ytdlpPending = true;
  const reqId = uid('q');
  native.infoReq.set(reqId, (m) => {
    item.ytdlpPending = false;
    if (m && m.info) {
      if (m.cookies) item.needsCookies = true;
      try {
        applyYt(item, VG.yt.fromYtdlp(m.info), 'ytdlp');
        item.ytdlpError = '';
      } catch (e) {
        item.ytdlpError = e.message;
      }
    } else if (m && m.error) item.ytdlpError = m.error;
  });
  native.port.postMessage({ cmd: 'info', id: reqId, url: item.url });
}

function applyYt(item, r, source) {
  if (r.title) item.title = r.title;
  if (r.duration) item.duration = r.duration;
  item.live = !!r.live;
  item.options = r.options.map((o) => ({ ...o, id: uid('o') }));
  item._ytAudios = r.audios || [];
  item.audioTracks = r.audioTracks || [];
  item.subTracks = (r.subTracks || []).map((x) => ({ ...x, _lang: x.lang }));
  item.source = source;
  item.notes = [];
  if (item.live) item.notes.push('Transmisja na żywo – yt-dlp pobierze ją od bieżącego momentu.');
  if (r.preview) {
    item.notes.push(
      'Strona odtwarza tylko zwiastun' +
        (r.preview.seconds ? ` (${VG.formatDuration(r.preview.seconds)})` : '') +
        ', a nie pełny film' +
        (r.preview.reason ? ` – YouTube: „${r.preview.reason}”` : '') +
        '. Pełna lista formatów przyjdzie z yt-dlp, jeśli Twoje konto w Firefoksie ma dostęp (np. Premium).'
    );
  } else if (source === 'page' && !r.hasFormats)
    item.notes.push('YouTube nie udostępnił listy formatów na stronie – dostępna jest opcja „Najlepsza”.');
}

async function addYoutube(tabId, id, pr) {
  if (!/^[\w-]{11}$/.test(id)) return;
  const t = tabState(tabId);
  const key = 'yt:' + id;
  for (const [k, it] of t.items) if (it.kind === 'youtube' && k !== key) t.items.delete(k);
  let item = t.items.get(key);
  if (item && (item.source !== 'none' || !pr)) {
    requestYtdlpInfo(item);
    return;
  }
  if (!item) {
    item = {
      id: uid('i'),
      key,
      kind: 'youtube',
      url: VG.yt.watchUrl(id),
      ytId: id,
      tabId,
      status: 'parsing',
      error: '',
      title: '',
      pageUrl: '',
      referer: '',
      duration: 0,
      live: false,
      drm: false,
      notes: [],
      options: [],
      source: 'none',
      created: Date.now(),
    };
    t.items.set(key, item);
    updateBadge(tabId);
  }
  try {
    if (!pr) pr = VG.yt.extractPlayerResponse(await fetchText(item.url + '&hl=en', ''));
  } catch (e) {}
  if (pr && pr.videoDetails && pr.videoDetails.videoId === id) applyYt(item, VG.yt.fromPlayerResponse(pr), 'page');
  else if (!item.options.length) applyYt(item, VG.yt.fromPlayerResponse({ videoDetails: { videoId: id } }), 'none');
  item.status = 'ready';
  updateBadge(tabId);
  if (await nativeReady()) requestYtdlpInfo(item);
}

function ytParams(item, option, choice) {
  const tracks = item.audioTracks || [];
  const track = choice && choice.audio && tracks.some((t) => t.id === choice.audio) ? choice.audio : '';
  const def = tracks.find((t) => t.isDefault);
  const selector = VG.yt.selector(option, item._ytAudios || [], track);
  const sub = choice && choice.subTrack;
  let suffix = option.ytSuffix || '';
  if (track && (!def || def.id !== track)) suffix = (suffix + ' ' + track).trim();
  return { selector, suffix, subs: sub ? { lang: sub.lang, auto: !!sub.auto } : null };
}

function runYoutube(job, item, option) {
  if (native.state !== 'ok' || !native.port)
    throw new Error('Program pomocniczy nie jest zainstalowany – użyj przycisku „⧉” (kopiuj komendę) albo zainstaluj pomocnika (README).');
  if (!native.info || !native.info.ytdlp) throw new Error('Program pomocniczy nie znalazł yt-dlp. Zainstaluj: winget install yt-dlp.yt-dlp');
  return new Promise((resolve, reject) => {
    const yt = ytParams(item, option, job.choice);
    const sel = yt.selector.split('/')[0];
    job.native = { resolve, reject, parts: sel.includes('+') ? 2 : 1, lastPart: 1, base: 0, lastDl: 0 };
    job.phase = 'Uruchamianie yt-dlp';
    job.itemKey = item.key;
    job.tabId = item.tabId;
    native.port.postMessage({
      cmd: 'download',
      id: job.id,
      url: item.url,
      format: yt.selector,
      output: VG.yt.outputTemplate(yt.suffix),
      subs: yt.subs,
      cookies: !!item.needsCookies,
    });
  });
}

function findItem(tabId, itemId) {
  const t = tabs.get(tabId);
  if (!t) return null;
  for (const it of t.items.values()) if (it.id === itemId) return it;
  return null;
}

function startJob(tabId, itemId, optionId, audioId, subId) {
  const item = findItem(tabId, itemId);
  if (!item) throw new Error('Nie znaleziono wideo – odśwież listę');
  const option = item.options.find((o) => o.id === optionId);
  if (!option) throw new Error('Nie znaleziono wybranej wersji');
  const job = {
    id: uid('j'),
    title: item.title || VG.fileNameFromUrl(item.url) || 'video',
    label: option.label + (option.hdr && option.hdr.isHdr ? ' · ' + option.hdr.label : ''),
    status: 'running',
    phase: 'Start',
    progress: 0,
    bytes: 0,
    speed: 0,
    files: [],
    downloadIds: [],
    note: '',
    error: '',
    ctrl: new AbortController(),
    keyCache: new Map(),
    choice: {
      audio: audioId && (item.audioTracks || []).some((t) => t.id === audioId) ? audioId : '',
      subTrack: (subId && (item.subTracks || []).find((x) => x.id === subId)) || null,
    },
  };
  if (job.choice.audio) {
    const tr = item.audioTracks.find((t) => t.id === job.choice.audio);
    if (tr && !tr.isDefault) job.label += ' · ' + tr.label;
  }
  if (job.choice.subTrack) job.label += ' · napisy: ' + job.choice.subTrack.label;
  jobs.set(job.id, job);
  const run =
    item.kind === 'hls' ? runHls : item.kind === 'dash' ? runDash : item.kind === 'youtube' ? runYoutube : runFile;
  Promise.resolve()
    .then(() => run(job, item, option))
    .then(() => {
      job.status = 'done';
      job.progress = 1;
      job.phase = 'Gotowe';
    })
    .catch((e) => {
      if (job.ctrl.signal.aborted || (e && e.name === 'AbortError')) {
        job.status = 'canceled';
        job.phase = 'Anulowano';
      } else {
        job.status = 'error';
        job.error = String((e && e.message) || e);
        console.error('[TabVideoGrab]', e);
      }
    })
    .finally(() => {
      job.keyCache.clear();
      job.speed = 0;
    });
  return job.id;
}

// ---------------------------------------------------------------------------
// Komunikacja z popupem
// ---------------------------------------------------------------------------
function pubItem(item) {
  return {
    id: item.id,
    kind: item.kind,
    url: item.url,
    title: item.title,
    status: item.status,
    error: item.error,
    duration: item.duration,
    live: item.live,
    drm: item.drm,
    container: item.container || '',
    notes: item.notes,
    source: item.source || '',
    entries: (item.entries || []).map((e) => ({ id: e.id, name: e.name, url: e.url, group: e.group, added: e.added })),
    loadingMore: !!item.ytdlpPending,
    moreError: item.ytdlpError || '',
    audioTracks: (item.audioTracks || []).map((t) => ({ id: t.id, label: t.label, isDefault: !!t.isDefault })),
    subTracks: (item.subTracks || []).map((t) => ({ id: t.id, label: t.label })),
    options: item.options.map((o) => ({
      id: o.id,
      label: o.label,
      width: o.width || 0,
      height: o.height || 0,
      fps: o.fps || 0,
      bandwidth: o.bandwidth || 0,
      codecs: o.codecs || '',
      hdr: o.hdr || null,
      audio: o.audio || null,
      audioOnly: !!o.audioOnly,
      drm: !!(o.drm || (item.drm && item.kind !== 'file')),
      fromPlayer: !!o.fromPlayer,
      size: o.size || (o.bandwidth && item.duration && !item.live ? (o.bandwidth * item.duration) / 8 : 0),
      sizeExact: !!o.size,
      auto: !!o.auto,
      yt: item.kind === 'youtube',
    })),
  };
}

function pubJob(j) {
  return {
    id: j.id,
    title: j.title,
    label: j.label,
    status: j.status,
    phase: j.phase,
    progress: j.progress,
    bytes: j.bytes,
    speed: j.speed,
    files: j.files,
    note: j.note,
    error: j.error,
    canReveal: !!(j.fullPaths && j.fullPaths.length && native.port),
  };
}

async function getState(tabId) {
  const t = tabs.get(tabId);
  let tab = null;
  try {
    tab = await browser.tabs.get(tabId);
  } catch (e) {}
  const items = t ? [...t.items.values()] : [];
  for (const it of items) if (tab && it.kind !== 'youtube' && it.pageUrl === tab.url && tab.title) it.title = tab.title;
  if (native.state !== 'ok') nativeConnect(); // wykryj pomocnika zainstalowanego w trakcie działania
  return {
    native: {
      state: native.state,
      ytdlp: native.info ? native.info.ytdlp : null,
      ffmpeg: native.info ? native.info.ffmpeg : false,
      outDir: native.info ? native.info.outDir : '',
      error: native.error,
    },
    items: items.sort((a, b) => b.created - a.created).map(pubItem),
    jobs: [...jobs.values()].reverse().map(pubJob),
  };
}

browser.runtime.onMessage.addListener((msg, sender) => {
  switch (msg && msg.type) {
    case 'dom-videos':
      if (sender.tab) onDomVideos(sender.tab.id, msg, sender);
      return;
    case 'yt-video':
      if (sender.tab) addYoutube(sender.tab.id, msg.id, msg.playerResponse);
      return;
    case 'state':
      return getState(msg.tabId);
    case 'yt-command': {
      const item = findItem(msg.tabId, msg.itemId);
      const option = item && item.options.find((o) => o.id === msg.optionId);
      if (!item || !option) return Promise.resolve('');
      const sub = (msg.subId && (item.subTracks || []).find((x) => x.id === msg.subId)) || null;
      const yt = ytParams(item, option, { audio: msg.audioId, subTrack: sub });
      const js = native.info && native.info.jsRuntime ? String(native.info.jsRuntime).split(':')[0] : '';
      return Promise.resolve(
        VG.yt.command(item.ytId, yt.selector, yt.suffix, yt.subs, { cookies: !!item.needsCookies, js: js === 'deno' ? '' : js })
      );
    }
    case 'reveal': {
      const j = jobs.get(msg.jobId);
      if (j && j.fullPaths && native.port) native.port.postMessage({ cmd: 'reveal', path: j.fullPaths[j.fullPaths.length - 1] });
      return Promise.resolve(true);
    }
    case 'download':
      try {
        return Promise.resolve({ jobId: startJob(msg.tabId, msg.itemId, msg.optionId, msg.audioId, msg.subId) });
      } catch (e) {
        return Promise.resolve({ error: e.message });
      }
    case 'cancel': {
      const j = jobs.get(msg.jobId);
      if (j && j.status === 'running') {
        j.ctrl.abort();
        if (j.native && native.port) native.port.postMessage({ cmd: 'cancel', id: j.id });
        for (const id of j.downloadIds) browser.downloads.cancel(id).catch(() => {});
      }
      return Promise.resolve(true);
    }
    case 'analyze-entry': {
      const item = findItem(msg.tabId, msg.itemId);
      const entry = item && item.entries && item.entries.find((e) => e.id === msg.entryId);
      if (!entry) return Promise.resolve({ error: 'Nie znaleziono pozycji' });
      const referer = item.referer || item.pageUrl;
      return sniffKind(entry.url, referer)
        .then((k) => {
          entry.added = true;
          addItem(item.tabId, k.kind, entry.url, {
            referer,
            title: entry.name || VG.fileNameFromUrl(entry.url),
            mime: k.mime,
            size: k.size,
            live: k.live,
          });
          return { ok: true };
        })
        .catch((e) => ({ error: 'Nie udało się otworzyć: ' + e.message }));
    }
    case 'clear-jobs':
      for (const [id, j] of jobs) if (j.status !== 'running') jobs.delete(id);
      return Promise.resolve(true);
    case 'clear-tab': {
      const t = tabs.get(msg.tabId);
      if (t) {
        t.items.clear(); // children/segDirs zostają, by warianty i segmenty nie wracały jako osobne pozycje
      }
      updateBadge(msg.tabId);
      return Promise.resolve(true);
    }
  }
});

VG.clearOpfs();
nativeConnect();
