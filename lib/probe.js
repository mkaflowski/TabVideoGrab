// Odczyt nagłówków plików MP4/MOV i WebM/MKV: rozdzielczość, kodek, głębia bitowa, charakterystyka przenoszenia (HDR).
(function (g) {
  const VG = (g.VG = g.VG || {});

  const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const u32 = (b, o) => b[o] * 16777216 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);

  function* boxes(b, start, end) {
    let o = start;
    while (o + 8 <= end) {
      let size = u32(b, o);
      const type = fourcc(b, o + 4);
      let hdr = 8;
      if (size === 1) {
        if (o + 16 > end) return;
        size = u64(b, o + 8);
        hdr = 16;
      } else if (size === 0) size = end - o;
      if (size < hdr) return;
      yield { type, start: o, content: o + hdr, end: Math.min(o + size, end) };
      o += size;
    }
  }
  const child = (b, box, type) => {
    for (const c of boxes(b, box.content, box.end)) if (c.type === type) return c;
    return null;
  };
  const path = (b, box, types) => {
    let cur = box;
    for (const t of types) {
      cur = cur && child(b, cur, t);
      if (!cur) return null;
    }
    return cur;
  };

  function parseVisualEntry(b, e) {
    const out = {
      format: e.type,
      width: u16(b, e.content + 24),
      height: u16(b, e.content + 26),
      encrypted: e.type === 'encv',
    };
    for (const c of boxes(b, e.content + 78, e.end)) {
      const p = c.content;
      switch (c.type) {
        case 'colr': {
          const ct = fourcc(b, p);
          if (ct === 'nclx' || ct === 'nclc') {
            out.primaries = u16(b, p + 4);
            out.transfer = u16(b, p + 6);
            out.matrix = u16(b, p + 8);
          }
          break;
        }
        case 'hvcC': {
          const prof = b[p + 1] & 0x1f;
          out.bitDepth = (b[p + 17] & 7) + 8;
          if (prof === 2 && out.bitDepth < 10) out.bitDepth = 10;
          break;
        }
        case 'avcC':
          out.bitDepth = b[p + 1] === 110 ? 10 : 8;
          break;
        case 'av1C': {
          const x = b[p + 2];
          out.bitDepth = (x >> 6) & 1 ? ((x >> 5) & 1 ? 12 : 10) : 8;
          break;
        }
        case 'vpcC': {
          const v = p + 4;
          out.bitDepth = b[v + 2] >> 4;
          if (out.transfer === undefined) out.transfer = b[v + 4];
          break;
        }
        case 'dvcC':
        case 'dvvC':
        case 'dvwC':
          out.dolby = true;
          break;
        case 'mdcv':
        case 'clli':
        case 'SmDm':
        case 'CoLL':
          out.hdrMeta = true;
          break;
        case 'sinf': {
          out.encrypted = true;
          const frma = child(b, c, 'frma');
          if (frma) out.format = fourcc(b, frma.content);
          break;
        }
      }
    }
    if (/^(dvh|dva|dav)/.test(out.format)) out.dolby = true;
    return out;
  }

  const FORMAT_CODEC = {
    avc1: 'avc1', avc3: 'avc1', hvc1: 'hvc1', hev1: 'hvc1', dvh1: 'dvh1', dvhe: 'dvh1',
    av01: 'av01', dav1: 'dav1', vp09: 'vp09', vp08: 'vp8',
    mp4a: 'mp4a', 'ec-3': 'ec-3', 'ac-3': 'ac-3', Opus: 'opus', fLaC: 'flac',
  };

  // b: bajty całego pudełka moov (od jego nagłówka)
  VG.parseMoov = function (b) {
    const moov = boxes(b, 0, b.length).next().value;
    if (!moov || moov.type !== 'moov') return null;
    const res = { duration: 0, video: null, audio: [] };
    const mvhd = child(b, moov, 'mvhd');
    if (mvhd) {
      const c = mvhd.content;
      const v1 = b[c] === 1;
      const ts = v1 ? u32(b, c + 20) : u32(b, c + 12);
      const dur = v1 ? u64(b, c + 24) : u32(b, c + 16);
      if (ts) res.duration = dur / ts;
    }
    for (const trak of boxes(b, moov.content, moov.end)) {
      if (trak.type !== 'trak') continue;
      const hdlr = path(b, trak, ['mdia', 'hdlr']);
      if (!hdlr) continue;
      const handler = fourcc(b, hdlr.content + 8);
      const stsd = path(b, trak, ['mdia', 'minf', 'stbl', 'stsd']);
      const entry = stsd ? boxes(b, stsd.content + 8, stsd.end).next().value : null;
      if (handler === 'vide' && !res.video) {
        const tkhd = child(b, trak, 'tkhd');
        const info = entry ? parseVisualEntry(b, entry) : {};
        if (tkhd && (!info.width || !info.height)) {
          info.width = Math.round(u32(b, tkhd.end - 8) / 65536);
          info.height = Math.round(u32(b, tkhd.end - 4) / 65536);
        }
        res.video = info;
      } else if (handler === 'soun' && entry) {
        let f = entry.type;
        if (f === 'enca') {
          const sinf = child(b, { content: entry.content + 28, end: entry.end }, 'sinf');
          const frma = sinf && child(b, sinf, 'frma');
          if (frma) f = fourcc(b, frma.content);
        }
        res.audio.push(FORMAT_CODEC[f] || f);
      }
    }
    return res;
  };

  async function probeMp4(url, first, total, fetchRange) {
    const read = async (o, len) => {
      if (o + len <= first.length) return first.subarray(o, o + len);
      return (await fetchRange(url, o, o + len - 1)).bytes;
    };
    let off = 0;
    for (let i = 0; i < 64; i++) {
      if (total && off + 8 > total) break;
      const h = await read(off, 16);
      if (h.length < 8) break;
      let size = u32(h, 0);
      const type = fourcc(h, 4);
      if (!/^[\x20-\x7e]{4}$/.test(type)) break;
      if (size === 1) size = u64(h, 8);
      else if (size === 0) size = total ? total - off : 0;
      if (!size || size < 8) break;
      if (type === 'moov') {
        if (size > 64 * 1024 * 1024) break;
        return VG.parseMoov(await read(off, size));
      }
      off += size;
    }
    return null;
  }

  // ---- EBML (WebM / Matroska) ----
  function readVint(b, o, keepMarker) {
    const first = b[o];
    if (first === undefined || first === 0) return null;
    let len = 1;
    let mask = 0x80;
    while (!(first & mask)) {
      len++;
      mask >>= 1;
    }
    if (o + len > b.length) return null;
    let val = keepMarker ? first : first & (mask - 1);
    let allOnes = (first & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) {
      val = val * 256 + b[o + i];
      if (b[o + i] !== 0xff) allOnes = false;
    }
    return { val, len, unknown: !keepMarker && allOnes };
  }
  function* elements(b, start, end) {
    let o = start;
    while (o < end) {
      const id = readVint(b, o, true);
      if (!id) return;
      const sz = readVint(b, o + id.len, false);
      if (!sz) return;
      const ds = o + id.len + sz.len;
      const de = sz.unknown ? end : Math.min(ds + sz.val, end);
      yield { id: id.val, start: ds, end: de };
      o = sz.unknown ? end : ds + sz.val;
    }
  }
  const euint = (b, s, e) => {
    let v = 0;
    for (let i = s; i < e; i++) v = v * 256 + b[i];
    return v;
  };
  const estr = (b, s, e) => String.fromCharCode(...b.subarray(s, e)).replace(/\0+$/, '');

  const MKV_CODEC = { V_VP9: 'vp9', V_VP8: 'vp8', V_AV1: 'av01', 'V_MPEG4/ISO/AVC': 'avc1', V_MPEGH_ISO_HEVC: 'hvc1', A_OPUS: 'opus', A_VORBIS: 'vorbis', A_AAC: 'mp4a', A_EAC3: 'ec-3', A_AC3: 'ac-3', A_FLAC: 'flac' };

  function probeEbml(b) {
    const res = { container: 'webm', duration: 0, video: null, audio: [] };
    let timecodeScale = 1e6;
    let rawDur = 0;
    for (const top of elements(b, 0, b.length)) {
      if (top.id === 0x1a45dfa3) {
        for (const h of elements(b, top.start, top.end)) {
          if (h.id === 0x4282 && estr(b, h.start, h.end) === 'matroska') res.container = 'mkv';
        }
      } else if (top.id === 0x18538067) {
        for (const s of elements(b, top.start, top.end)) {
          if (s.id === 0x1f43b675) break; // Cluster
          if (s.id === 0x1549a966) {
            for (const i of elements(b, s.start, s.end)) {
              if (i.id === 0x2ad7b1) timecodeScale = euint(b, i.start, i.end);
              if (i.id === 0x4489) {
                const len = i.end - i.start;
                const dv = new DataView(b.buffer, b.byteOffset + i.start, len);
                rawDur = len === 8 ? dv.getFloat64(0) : len === 4 ? dv.getFloat32(0) : 0;
              }
            }
          }
          if (s.id !== 0x1654ae6b) continue;
          for (const te of elements(b, s.start, s.end)) {
            if (te.id !== 0xae) continue;
            let type = 0;
            let codec = '';
            let enc = false;
            const v = {};
            for (const f of elements(b, te.start, te.end)) {
              if (f.id === 0x83) type = euint(b, f.start, f.end);
              else if (f.id === 0x86) codec = estr(b, f.start, f.end);
              else if (f.id === 0x6d80) enc = true;
              else if (f.id === 0xe0) {
                for (const x of elements(b, f.start, f.end)) {
                  if (x.id === 0xb0) v.width = euint(b, x.start, x.end);
                  else if (x.id === 0xba) v.height = euint(b, x.start, x.end);
                  else if (x.id === 0x55b0) {
                    for (const c of elements(b, x.start, x.end)) {
                      if (c.id === 0x55b2) v.bitDepth = euint(b, c.start, c.end);
                      else if (c.id === 0x55ba) v.transfer = euint(b, c.start, c.end);
                      else if (c.id === 0x55bb) v.primaries = euint(b, c.start, c.end);
                      else if (c.id === 0x55b1) v.matrix = euint(b, c.start, c.end);
                      else if (c.id === 0x55d0 || c.id === 0x55bc || c.id === 0x55bd) v.hdrMeta = true;
                    }
                  }
                }
              }
            }
            if (type === 1 && !res.video) res.video = { ...v, format: MKV_CODEC[codec] || codec, encrypted: enc };
            else if (type === 2) res.audio.push(MKV_CODEC[codec] || codec);
          }
        }
      }
    }
    if (rawDur) res.duration = (rawDur * timecodeScale) / 1e9;
    return res;
  }

  function indexOf(b, pat) {
    outer: for (let i = 0; i <= b.length - pat.length; i++) {
      for (let j = 0; j < pat.length; j++) if (b[i + j] !== pat[j]) continue outer;
      return i;
    }
    return -1;
  }

  // fetchRange(url, start, end) -> { bytes: Uint8Array, total: number }
  VG.probeFile = async function (url, fetchRange) {
    const first = await fetchRange(url, 0, 512 * 1024 - 1);
    const b = first.bytes;
    let res = null;
    if (b.length >= 8 && ['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pdin', 'styp'].includes(fourcc(b, 4))) {
      res = await probeMp4(url, b, first.total, fetchRange);
      // Gdy colr nie mówi nic o krzywej HDR: szukaj w strumieniu HEVC komunikatów SEI
      // mastering_display_colour_volume (137) / content_light_level (144) – typowe dla HDR10.
      if (res && res.video && res.video.transfer !== 16 && res.video.transfer !== 18 && /^(hvc1|hev1)$/.test(res.video.format)) {
        if (indexOf(b, [0x4e, 0x01, 0x89, 0x18]) >= 0 || indexOf(b, [0x4e, 0x01, 0x90, 0x04]) >= 0) res.video.hdrMeta = true;
      }
      if (res) res.container = /^\x00\x00\x00.ftypqt/.test(fourcc(b, 0) + fourcc(b, 4) + fourcc(b, 8)) ? 'mov' : 'mp4';
    } else if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
      res = probeEbml(b);
    }
    return { total: first.total || 0, ...(res || {}) };
  };

  if (typeof module !== 'undefined') module.exports = VG;
})(globalThis);
