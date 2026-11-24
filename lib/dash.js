// Parser manifestów MPEG-DASH (mpd). Wymaga DOMParser (strona tła).
(function (g) {
  const VG = (g.VG = g.VG || {});
  const MAX_SEGMENTS = 200000;

  const kids = (el, name) => (el ? Array.from(el.children).filter((c) => c.localName === name) : []);
  const kid = (el, name) => kids(el, name)[0] || null;

  function baseOf(el, base) {
    const b = kid(el, 'BaseURL');
    const t = b && b.textContent.trim();
    return t ? VG.resolveUrl(t, base) : base;
  }

  function parseFps(s) {
    if (!s) return 0;
    const [a, b] = String(s).split('/').map(Number);
    return b ? a / b : a || 0;
  }

  function transferOf(...els) {
    for (const el of els) {
      if (!el) continue;
      for (const p of [...kids(el, 'EssentialProperty'), ...kids(el, 'SupplementalProperty')]) {
        const s = p.getAttribute('schemeIdUri') || '';
        if (/cicp:TransferCharacteristics/i.test(s)) return parseInt(p.getAttribute('value'), 10);
      }
    }
    return undefined;
  }

  function fill(tpl, vars) {
    return tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time|SubNumber)(?:%0(\d+)([dxX]))?\$|\$\$/g, (m, name, width, fmt) => {
      if (!name) return '$';
      let v = vars[name];
      if (v === undefined) return m;
      if (width && name !== 'RepresentationID') {
        v = fmt && fmt !== 'd' ? Number(v).toString(16) : String(v);
        if (fmt === 'X') v = v.toUpperCase();
        v = v.padStart(+width, '0');
      }
      return String(v);
    });
  }

  function parseRange(r) {
    if (!r) return null;
    const [a, b] = r.split('-').map(Number);
    return { offset: a, length: b - a + 1 };
  }

  function mergedTemplate(els) {
    const tpls = els.map((e) => kid(e, 'SegmentTemplate')).filter(Boolean);
    if (!tpls.length) return null;
    const get = (name) => {
      for (let i = tpls.length - 1; i >= 0; i--) {
        const v = tpls[i].getAttribute(name);
        if (v !== null) return v;
      }
      return null;
    };
    let timeline = null;
    for (let i = tpls.length - 1; i >= 0; i--) {
      const t = kid(tpls[i], 'SegmentTimeline');
      if (t) {
        timeline = t;
        break;
      }
    }
    return { get, timeline };
  }

  function buildSegments(rep, as, period, base, periodDur) {
    const vars = { RepresentationID: rep.getAttribute('id') || '', Bandwidth: rep.getAttribute('bandwidth') || '' };
    const tpl = mergedTemplate([period, as, rep]);
    if (tpl) {
      const timescale = +(tpl.get('timescale') || 1);
      const start = tpl.get('startNumber') !== null ? +tpl.get('startNumber') : 1;
      const pto = +(tpl.get('presentationTimeOffset') || 0);
      const media = tpl.get('media');
      const initT = tpl.get('initialization');
      if (!media) throw new Error('SegmentTemplate bez atrybutu media');
      const init = initT ? { url: VG.resolveUrl(fill(initT, vars), base) } : null;
      const segments = [];
      if (tpl.timeline) {
        let t = 0;
        let n = start;
        const S = kids(tpl.timeline, 'S');
        S.forEach((s, idx) => {
          if (s.getAttribute('t') !== null) t = +s.getAttribute('t');
          const d = +s.getAttribute('d');
          let r = +(s.getAttribute('r') || 0);
          if (r < 0) {
            const nextT = S[idx + 1] && S[idx + 1].getAttribute('t');
            const endT = nextT != null ? +nextT : periodDur ? pto + periodDur * timescale : t + d;
            r = Math.max(0, Math.ceil((endT - t) / d) - 1);
          }
          for (let i = 0; i <= r && segments.length < MAX_SEGMENTS; i++) {
            segments.push({ url: VG.resolveUrl(fill(media, { ...vars, Number: n, Time: t }), base) });
            t += d;
            n++;
          }
        });
      } else {
        const dur = +tpl.get('duration');
        if (!dur) throw new Error('SegmentTemplate bez duration i SegmentTimeline');
        if (!periodDur) throw new Error('Nieznana długość materiału');
        const count = Math.min(MAX_SEGMENTS, Math.ceil((periodDur * timescale) / dur - 1e-6));
        for (let i = 0; i < count; i++) {
          segments.push({
            url: VG.resolveUrl(fill(media, { ...vars, Number: start + i, Time: pto + i * dur }), base),
          });
        }
      }
      return { init, segments, single: false };
    }

    const lists = [period, as, rep].map((e) => kid(e, 'SegmentList')).filter(Boolean);
    if (lists.length) {
      const sl = lists[lists.length - 1];
      const initEl = lists
        .map((l) => kid(l, 'Initialization'))
        .filter(Boolean)
        .pop();
      const init = initEl
        ? {
            url: VG.resolveUrl(initEl.getAttribute('sourceURL') || '', base),
            range: parseRange(initEl.getAttribute('range')),
          }
        : null;
      const segments = kids(sl, 'SegmentURL').map((su) => ({
        url: VG.resolveUrl(su.getAttribute('media') || '', base),
        range: parseRange(su.getAttribute('mediaRange')),
      }));
      return { init, segments, single: false };
    }

    // SegmentBase lub samo BaseURL -> jeden plik
    return { init: null, segments: [{ url: base }], single: true };
  }

  VG.dash = {
    parse(text, url) {
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      const mpd = doc.documentElement;
      if (!mpd || mpd.localName !== 'MPD') throw new Error('Nieprawidłowy manifest MPD');
      const dynamic = mpd.getAttribute('type') === 'dynamic';
      const total = VG.parseISODuration(mpd.getAttribute('mediaPresentationDuration'));
      const base0 = baseOf(mpd, url);
      const periods = kids(mpd, 'Period');
      if (!periods.length) throw new Error('Manifest MPD bez Period');
      const period = periods[0];
      let pdur = VG.parseISODuration(period.getAttribute('duration'));
      if (!pdur) {
        if (periods.length === 1) pdur = total;
        else {
          const s0 = VG.parseISODuration(period.getAttribute('start'));
          const s1 = VG.parseISODuration(periods[1].getAttribute('start'));
          pdur = s1 ? s1 - s0 : total;
        }
      }
      const baseP = baseOf(period, base0);
      const videos = [];
      const audios = [];
      const texts = [];
      for (const as of kids(period, 'AdaptationSet')) {
        const baseA = baseOf(as, baseP);
        const asDrm = kids(as, 'ContentProtection').length > 0;
        for (const rep of kids(as, 'Representation')) {
          const a = (n) => rep.getAttribute(n) ?? as.getAttribute(n);
          const mime = a('mimeType') || '';
          const codecs = a('codecs') || '';
          let type = as.getAttribute('contentType') || mime.split('/')[0];
          if (!type || type === 'application') {
            if (/^(avc|hvc|hev|av01|vp0?9|vp8|dvh|dav)/i.test(codecs)) type = 'video';
            else if (/^(mp4a|ac-3|ec-3|ac-4|opus|vorbis|flac|dts)/i.test(codecs)) type = 'audio';
          }
          if (/stpp|wvtt/i.test(codecs) || /^text\/|ttml/i.test(mime)) type = 'text';
          if (type !== 'video' && type !== 'audio' && type !== 'text') continue;
          const drm = asDrm || kids(rep, 'ContentProtection').length > 0;
          const baseR = baseOf(rep, baseA);
          let seg = null;
          let segErr = '';
          try {
            seg = buildSegments(rep, as, period, baseR, pdur);
          } catch (e) {
            segErr = e.message;
          }
          const o = { id: rep.getAttribute('id') || '', bandwidth: +a('bandwidth') || 0, codecs, mime, drm, seg, segErr };
          if (type === 'video') {
            videos.push({
              ...o,
              width: +a('width') || 0,
              height: +a('height') || 0,
              fps: parseFps(a('frameRate')),
              transfer: transferOf(rep, as),
            });
          } else if (type === 'text') {
            const lbl = kid(rep, 'Label') || kid(as, 'Label');
            const role = kid(as, 'Role');
            texts.push({
              ...o,
              lang: as.getAttribute('lang') || '',
              label: (lbl && lbl.textContent.trim()) || as.getAttribute('label') || '',
              role: role ? role.getAttribute('value') || '' : '',
            });
          } else {
            const acc = kid(rep, 'AudioChannelConfiguration') || kid(as, 'AudioChannelConfiguration');
            const lbl = kid(rep, 'Label') || kid(as, 'Label');
            const role = kid(as, 'Role');
            audios.push({
              ...o,
              lang: as.getAttribute('lang') || '',
              label: (lbl && lbl.textContent.trim()) || as.getAttribute('label') || '',
              role: role ? role.getAttribute('value') || '' : '',
              channels: acc ? acc.getAttribute('value') || '' : '',
            });
          }
        }
      }
      return { dynamic, duration: pdur || total || 0, multiPeriod: periods.length > 1, videos, audios, texts };
    },
  };
})(globalThis);
