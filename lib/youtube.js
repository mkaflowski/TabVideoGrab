// YouTube: lista formatów, ścieżek dźwiękowych i napisów (ze strony lub z yt-dlp), budowa poleceń yt-dlp.
(function (g) {
  const VG = (g.VG = g.VG || {});

  const TRANSFER = {
    COLOR_TRANSFER_CHARACTERISTICS_SMPTEST2084: 16,
    COLOR_TRANSFER_CHARACTERISTICS_ARIB_STD_B67: 18,
    COLOR_TRANSFER_CHARACTERISTICS_BT709: 1,
  };
  const PRIMARIES = { COLOR_PRIMARIES_BT2020: 9, COLOR_PRIMARIES_BT709: 1 };

  // Wyciąga obiekt JSON przypisany po znaczniku (np. "ytInitialPlayerResponse = {...};")
  function extractJson(text, marker) {
    let i = text.indexOf(marker);
    if (i < 0) return null;
    i = text.indexOf('{', i + marker.length);
    if (i < 0) return null;
    let depth = 0;
    let inStr = false;
    let quote = '';
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (c === '\\') j++;
        else if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") {
        inStr = true;
        quote = c;
      } else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(i, j + 1));
          } catch (e) {
            return null;
          }
        }
      }
    }
    return null;
  }

  const watchUrl = (id) => 'https://www.youtube.com/watch?v=' + id;

  // Fragment szablonu nazwy yt-dlp: bez znaków specjalnych
  const safeSuffix = (s) => String(s || '').replace(/[%\\/:*?"<>|]/g, '').trim();
  const outputTemplate = (suffix) => `%(title)s [%(id)s]${suffix ? ' ' + safeSuffix(suffix) : ''}.%(ext)s`;
  const safeLang = (l) => String(l || '').replace(/[^\w-]/g, '');

  // sub: { lang, auto } | null
  function subArgs(sub) {
    if (!sub || !safeLang(sub.lang)) return [];
    return [sub.auto ? '--write-auto-subs' : '--write-subs', '--sub-langs', safeLang(sub.lang), '--convert-subs', 'srt'];
  }

  // opts: { cookies: bool, js: 'node'|'bun'|'' }
  function command(id, sel, suffix, sub, opts) {
    opts = opts || {};
    const pre = [opts.js ? `--js-runtimes ${opts.js}` : '', opts.cookies ? '--cookies-from-browser firefox' : ''].filter(Boolean).join(' ');
    const extra = subArgs(sub).join(' ');
    return `yt-dlp ${pre ? pre + ' ' : ''}-f "${sel}"${extra ? ' ' + extra : ''} -o "${outputTemplate(suffix)}" "${watchUrl(id)}"`;
  }

  function audioRank(a, preferM4a) {
    let s = a.bitrate || 0;
    if (a.isDefault) s += 1e9;
    if (a.drc) s -= 1e8;
    if (preferM4a !== undefined && (a.ext === 'm4a') === preferM4a) s += 1e7;
    return s;
  }

  function bestAudio(audios, videoExt) {
    if (!audios.length) return null;
    const preferM4a = videoExt === undefined ? undefined : videoExt === 'mp4';
    return audios.slice().sort((x, y) => audioRank(y, preferM4a) - audioRank(x, preferM4a))[0];
  }

  // Ścieżki dźwiękowe zgrupowane po kodzie języka. [{id, label, isDefault}] – pusta, gdy jest tylko jedna.
  function audioTracks(audios) {
    const map = new Map();
    for (const a of audios) {
      if (!a.track) continue;
      const t = map.get(a.track) || { id: a.track, label: a.trackLabel || a.track, isDefault: false };
      if (a.isDefault) t.isDefault = true;
      map.set(a.track, t);
    }
    const list = [...map.values()];
    if (list.length < 2) return [];
    return list.sort((x, y) => (y.isDefault ? 1 : 0) - (x.isDefault ? 1 : 0) || x.label.localeCompare(y.label));
  }

  const audioFid = (a) => (a.exact || !a.track ? a.formatId : `${a.formatId}[language^=${safeLang(a.track)}]`);

  // Selektor formatu yt-dlp dla opcji i wybranej ścieżki dźwiękowej
  function selector(o, audios, track) {
    const inTrack = track ? audios.filter((a) => a.track === track) : [];
    const def = audios.filter((a) => a.isDefault);
    const pool = inTrack.length ? inTrack : def.length ? def : audios;
    const lf = track ? `[language^=${safeLang(track)}]` : '';
    if (o.auto) return track ? `bv*+ba${lf}/bv*+ba/b` : 'bv*+ba/b';
    if (o.audioOnly) {
      const a = bestAudio(pool);
      return a ? `${audioFid(a)}/ba${lf}/ba` : 'ba';
    }
    const v = o._v.formatId;
    const a = bestAudio(pool, o._v.ext);
    return a ? `${v}+${audioFid(a)}/${v}+ba${lf}/${v}+ba` : `${v}+ba/${v}`;
  }

  function dynamicRangeToHdr(dr) {
    const d = String(dr || '').toUpperCase();
    if (d === 'SDR') return { label: 'SDR', short: 'SDR', isHdr: false, detail: 'yt-dlp: SDR' };
    if (d === 'DV') return { label: 'Dolby Vision', short: 'DV', isHdr: true, detail: 'yt-dlp: Dolby Vision' };
    if (d === 'HLG') return { label: 'HLG', short: 'HLG', isHdr: true, detail: 'yt-dlp: HLG' };
    if (d.startsWith('HDR10+')) return { label: 'HDR10+', short: 'HDR10+', isHdr: true, detail: 'yt-dlp: HDR10+' };
    if (d.startsWith('HDR')) return { label: 'HDR10', short: 'HDR10', isHdr: true, detail: 'yt-dlp: ' + dr };
    return { label: '?', short: '', isHdr: null, detail: 'yt-dlp: ' + dr };
  }

  function buildOptions(videos, audios) {
    const def = audios.filter((a) => a.isDefault);
    const pool = def.length ? def : audios;
    const opts = [];
    for (const v of videos) {
      const a = bestAudio(pool, v.ext);
      // yt-dlp podaje dynamic_range wprost; dla danych ze strony: colorInfo + kodek, a na końcu etykieta „HDR”
      let hdr = v.dynamicRange
        ? dynamicRangeToHdr(v.dynamicRange)
        : VG.classifyHdr({ codecs: v.codecs, transfer: v.transfer, primaries: v.primaries });
      if (!hdr.isHdr && v.hdrHint) hdr = { label: 'HDR', short: 'HDR', isHdr: true, detail: VG.t('ytHdrHint') };
      const label = VG.qualityLabel(v.width, v.height);
      const suffix = [label.replace(/\s*\(.*\)/, ''), v.fps > 30 ? Math.round(v.fps) + 'fps' : '', hdr.isHdr ? hdr.short : '', VG.codecName(v.codecs)]
        .filter(Boolean)
        .join(' ');
      opts.push({
        label,
        width: v.width,
        height: v.height,
        fps: v.fps,
        bandwidth: (v.bitrate || 0) + (a ? a.bitrate || 0 : 0),
        codecs: v.codecs + (a && a.codecs ? ',' + a.codecs : ''),
        hdr,
        size: v.size && (!a || a.size) ? v.size + (a ? a.size : 0) : 0,
        ytSuffix: suffix,
        _v: v,
      });
    }
    opts.sort(
      (x, y) =>
        (y.height || 0) - (x.height || 0) ||
        (y.hdr.isHdr ? 1 : 0) - (x.hdr.isHdr ? 1 : 0) ||
        (y.fps || 0) - (x.fps || 0) ||
        (y.bandwidth || 0) - (x.bandwidth || 0)
    );
    opts.unshift({
      label: VG.t('best'),
      auto: true,
      codecs: '',
      hdr: { label: 'auto', short: '', isHdr: null, detail: VG.t('bestDetail') },
      ytSuffix: '',
    });
    const a = bestAudio(pool);
    if (a) opts.push({ label: 'Audio', audioOnly: true, bandwidth: a.bitrate, codecs: a.codecs, size: a.size || 0, ytSuffix: 'audio' });
    return opts;
  }

  const textOf = (n) => (n ? n.simpleText || (n.runs || []).map((r) => r.text).join('') : '');

  function result(meta, videos, audios, subs) {
    return {
      ...meta,
      options: buildOptions(videos, audios),
      audios,
      audioTracks: audioTracks(audios),
      subTracks: subs.sort((x, y) => (x.auto ? 1 : 0) - (y.auto ? 1 : 0) || x.label.localeCompare(y.label)),
      hasFormats: videos.length > 0,
    };
  }

  VG.yt = {
    watchUrl,
    command,
    outputTemplate,
    selector,
    subArgs,
    extractPlayerResponse(html) {
      return extractJson(html, 'ytInitialPlayerResponse =') || extractJson(html, 'ytInitialPlayerResponse=');
    },

    // Z danych odtwarzacza YouTube (ytInitialPlayerResponse)
    fromPlayerResponse(pr) {
      const vd = pr.videoDetails || {};
      const fmts = (pr.streamingData && pr.streamingData.adaptiveFormats) || [];
      const videos = [];
      const audios = [];
      for (const f of fmts) {
        const m = /^(video|audio)\/([\w-]+);\s*codecs="([^"]+)"/.exec(f.mimeType || '');
        if (!m) continue;
        const ext = m[2] === 'mp4' ? (m[1] === 'audio' ? 'm4a' : 'mp4') : m[2];
        const base = { formatId: String(f.itag), ext, codecs: m[3], bitrate: f.averageBitrate || f.bitrate || 0, size: +f.contentLength || 0 };
        if (m[1] === 'video') {
          const ci = f.colorInfo || {};
          videos.push({
            ...base,
            width: f.width || 0,
            height: f.height || 0,
            fps: f.fps || 0,
            transfer: TRANSFER[ci.transferCharacteristics],
            primaries: PRIMARIES[ci.primaries],
            hdrHint: /HDR/.test(f.qualityLabel || ''),
          });
        } else {
          const t = f.audioTrack || {};
          const track = t.id ? String(t.id).split('.')[0] : '';
          audios.push({
            ...base,
            track,
            trackLabel: t.displayName || track,
            isDefault: t.audioIsDefault !== false,
            drc: !!f.isDrc,
            exact: false,
          });
        }
      }
      const caps =
        (pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
      const subs = [];
      const seen = new Set();
      for (const c of caps) {
        const auto = c.kind === 'asr';
        const id = (auto ? 'auto:' : 'sub:') + c.languageCode;
        if (!c.languageCode || seen.has(id)) continue;
        seen.add(id);
        subs.push({ id, lang: c.languageCode, auto, label: (textOf(c.name) || c.languageCode).replace(/\s*\(auto-generated\)/i, '') + (auto ? VG.t('autoSubs') : '') });
      }
      // Zwiastun/podgląd zamiast filmu (np. film tylko dla Premium oglądany bez Premium):
      // status inny niż OK albo strumienie wyraźnie krótsze niż film.
      const ps = pr.playabilityStatus || {};
      const lengthMs = (+vd.lengthSeconds || 0) * 1000;
      const durs = fmts.map((f) => +f.approxDurationMs || 0).filter(Boolean);
      const streamMs = durs.length ? Math.max(...durs) : 0;
      const shortStreams = lengthMs > 0 && streamMs > 0 && streamMs < lengthMs * 0.9;
      const blocked = !!ps.status && ps.status !== 'OK';
      if (blocked || shortStreams) {
        const r = result({ title: vd.title || '', duration: +vd.lengthSeconds || 0, live: !!vd.isLive }, [], [], subs);
        r.preview = {
          reason: ps.reason || '',
          seconds: shortStreams ? Math.round(streamMs / 1000) : 0,
        };
        return r;
      }
      return result({ title: vd.title || '', duration: +vd.lengthSeconds || 0, live: !!vd.isLive }, videos, audios, subs);
    },

    // Z wyniku `yt-dlp -J` (przyciętego przez program pomocniczy)
    fromYtdlp(info) {
      const videos = [];
      const audios = [];
      for (const f of info.formats || []) {
        if (!f.format_id || /storyboard|mhtml/i.test(f.format_note || '') || f.ext === 'mhtml') continue;
        const hasV = f.vcodec && f.vcodec !== 'none';
        const hasA = f.acodec && f.acodec !== 'none';
        const size = f.filesize || f.filesize_approx || 0;
        const bitrate = (f.tbr || 0) * 1000;
        if (hasV && !hasA) {
          videos.push({
            formatId: f.format_id,
            ext: f.ext,
            codecs: f.vcodec,
            width: f.width || 0,
            height: f.height || 0,
            fps: f.fps || 0,
            bitrate,
            size,
            dynamicRange: f.dynamic_range || 'SDR',
          });
        } else if (hasA && !hasV) {
          const note = f.format_note || '';
          audios.push({
            formatId: f.format_id,
            ext: f.ext,
            codecs: f.acodec,
            bitrate,
            size,
            track: f.language || '',
            trackLabel: (note.split(',')[0] || '').replace(/\s*\(default\)/i, '').trim() || f.language || '',
            isDefault: /default/i.test(note),
            drc: /drc/i.test(f.format_id + ' ' + note),
            exact: true,
          });
        }
      }
      if (!audios.some((a) => a.isDefault)) audios.forEach((a) => (a.isDefault = true));
      // yt-dlp potrafi podać ten sam format kilka razy (https i m3u8) – zostaw jeden na rozdzielczość/kodek/HDR/fps
      const seen = new Map();
      for (const v of videos) {
        const k = [v.height, v.fps, v.dynamicRange, VG.codecName(v.codecs)].join('|');
        const prev = seen.get(k);
        if (!prev || (v.size && !prev.size) || (!!v.size === !!prev.size && v.bitrate > prev.bitrate)) seen.set(k, v);
      }
      const subs = [];
      for (const [lang, name] of Object.entries(info.subtitles || {})) subs.push({ id: 'sub:' + lang, lang, auto: false, label: name || lang });
      for (const [lang, name] of Object.entries(info.automatic_captions || {})) {
        const orig = /-orig$/.test(lang);
        subs.push({
          id: 'auto:' + lang,
          lang,
          auto: true,
          label: String(name || lang).replace(/\s*\(Original\)/i, '') + (orig ? VG.t('autoSubs') : VG.t('autoTranslated')),
        });
      }
      return result({ title: info.title || '', duration: info.duration || 0, live: !!info.is_live }, [...seen.values()], audios, subs);
    },
  };

  if (typeof module !== 'undefined') module.exports = VG;
})(globalThis);
