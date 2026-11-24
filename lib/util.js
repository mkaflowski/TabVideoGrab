// Wspólne funkcje pomocnicze (tło + popup).
(function (g) {
  const VG = (g.VG = g.VG || {});

  VG.resolveUrl = function (rel, base) {
    try {
      return new URL(rel, base).href;
    } catch (e) {
      return rel;
    }
  };

  // Lista atrybutów HLS: KEY=VALUE,KEY="VALUE,z,przecinkami"
  VG.parseAttrList = function (str) {
    const out = {};
    const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let m;
    while ((m = re.exec(str))) {
      let v = m[2];
      if (v.startsWith('"')) v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  };

  // ISO 8601 duration (PT1H2M3.5S) -> sekundy
  VG.parseISODuration = function (s) {
    if (!s) return 0;
    const m = /^P(?:([\d.]+)Y)?(?:([\d.]+)M)?(?:([\d.]+)W)?(?:([\d.]+)D)?(?:T(?:([\d.]+)H)?(?:([\d.]+)M)?(?:([\d.]+)S)?)?$/.exec(
      s.trim()
    );
    if (!m) return 0;
    const n = (i) => parseFloat(m[i] || 0);
    return n(1) * 31536000 + n(2) * 2592000 + n(3) * 604800 + n(4) * 86400 + n(5) * 3600 + n(6) * 60 + n(7);
  };

  VG.qualityLabel = function (w, h) {
    if (!w || !h) return h ? h + 'p' : '?';
    const short = Math.min(w, h);
    const long = Math.max(w, h);
    const eff = Math.max(short, Math.round((long * 9) / 16));
    const std = [144, 240, 360, 480, 540, 576, 720, 1080, 1440, 2160, 4320];
    let best = std[0];
    for (const s of std) if (Math.abs(s - eff) < Math.abs(best - eff)) best = s;
    const p = Math.abs(best - eff) / best < 0.12 ? best : short;
    if (p >= 4320) return '4320p (8K)';
    if (p >= 2160) return '2160p (4K)';
    if (p >= 1440) return '1440p (2K)';
    return p + 'p';
  };

  VG.codecName = function (codecs) {
    if (!codecs) return '';
    const names = [];
    for (const c of codecs.split(',')) {
      const s = c.trim().toLowerCase();
      let n = '';
      if (/^(avc1|avc3)/.test(s)) n = 'H.264';
      else if (/^(hvc1|hev1)/.test(s)) n = 'HEVC';
      else if (/^(dvh1|dvhe)/.test(s)) n = 'HEVC DV';
      else if (/^(dav1|dva1)/.test(s)) n = 'AV1 DV';
      else if (/^av01/.test(s)) n = 'AV1';
      else if (/^vp0?9/.test(s)) n = 'VP9';
      else if (/^vp0?8/.test(s)) n = 'VP8';
      else if (/^mp4a\.40\.(5|29)/.test(s)) n = 'HE-AAC';
      else if (/^mp4a/.test(s)) n = 'AAC';
      else if (/^ec-3/.test(s)) n = 'E-AC-3';
      else if (/^ac-3/.test(s)) n = 'AC-3';
      else if (/^ac-4/.test(s)) n = 'AC-4';
      else if (/^opus/.test(s)) n = 'Opus';
      else if (/^vorbis/.test(s)) n = 'Vorbis';
      else if (/^flac/.test(s)) n = 'FLAC';
      else n = c.trim();
      if (n && !names.includes(n)) names.push(n);
    }
    return names.join(' + ');
  };

  VG.isAudioOnlyCodecs = function (codecs) {
    if (!codecs) return false;
    return codecs
      .split(',')
      .every((c) => /^(mp4a|ec-3|ac-3|ac-4|opus|vorbis|flac|mp3|dts)/i.test(c.trim()));
  };

  VG.formatBytes = function (b) {
    if (!b || b < 0) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) {
      b /= 1024;
      i++;
    }
    return (b >= 100 || i === 0 ? b.toFixed(0) : b.toFixed(1)) + ' ' + u[i];
  };

  VG.formatBitrate = function (bps) {
    if (!bps) return '';
    if (bps >= 1e6) return (bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1) + ' Mb/s';
    return Math.round(bps / 1e3) + ' kb/s';
  };

  VG.formatDuration = function (sec) {
    if (!sec || !isFinite(sec)) return '';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (x) => String(x).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  };

  VG.sanitizeFilename = function (name) {
    let s = String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f~]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+/, '');
    if (s.length > 120) s = s.slice(0, 120).trim();
    s = s.replace(/[.\s]+$/, '');
    return s || 'video';
  };

  VG.hexToBytes = function (hex, len) {
    let h = String(hex).replace(/^0x/i, '');
    if (len) h = h.padStart(len * 2, '0');
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
    return out;
  };

  VG.fileNameFromUrl = function (url) {
    try {
      const p = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(p).replace(/\.[a-z0-9]{2,5}$/i, '');
    } catch (e) {
      return '';
    }
  };

  VG.urlExt = function (url) {
    try {
      const m = /\.([a-z0-9]{2,5})$/i.exec(new URL(url).pathname);
      return m ? m[1].toLowerCase() : '';
    } catch (e) {
      return '';
    }
  };

  VG.escapeHtml = function (s) {
    return String(s == null ? '' : s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  };

  if (typeof module !== 'undefined') module.exports = VG;
})(globalThis);
