// Parser playlist HLS (m3u8).
(function (g) {
  const VG = (g.VG = g.VG || {});

  function lines(text) {
    return text.split(/\r?\n/).map((l) => l.trim());
  }

  function parseByteRange(s, lastEnd) {
    if (!s) return null;
    const [n, o] = s.split('@');
    const length = parseInt(n, 10);
    const offset = o !== undefined ? parseInt(o, 10) : lastEnd || 0;
    return { offset, length };
  }

  VG.hls = {
    isMaster(text) {
      return /#EXT-X-STREAM-INF/.test(text);
    },

    // Prawdziwa playlista HLS (a nie zwykła lista M3U z kanałami / radiem)
    isHls(text) {
      return /#EXT-X-(TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE|ENDLIST|KEY|MAP|MEDIA:|PLAYLIST-TYPE|VERSION|I-FRAME)/.test(text);
    },

    // Zwykła lista M3U (IPTV, radio): [{ name, url, group }]
    parsePlain(text, baseUrl) {
      const out = [];
      let name = '';
      let group = '';
      for (const l of lines(text)) {
        if (!l) continue;
        if (l.startsWith('#EXTINF')) {
          const c = l.indexOf(',', l.indexOf(':'));
          name = c >= 0 ? l.slice(c + 1).trim() : '';
          const g = /group-title="([^"]*)"/i.exec(l);
          group = g ? g[1] : '';
          continue;
        }
        if (l.startsWith('#')) continue;
        if (!/^(https?:)?\/\/|^[\w./-]/i.test(l)) continue;
        out.push({ name, url: VG.resolveUrl(l, baseUrl), group });
        name = '';
        group = '';
        if (out.length >= 2000) break;
      }
      return out;
    },

    parseMaster(text, baseUrl) {
      const ls = lines(text);
      const variants = [];
      const media = [];
      const seen = new Set();
      for (let i = 0; i < ls.length; i++) {
        const l = ls[i];
        if (l.startsWith('#EXT-X-STREAM-INF:')) {
          const a = VG.parseAttrList(l.slice(18));
          let uri = null;
          for (let j = i + 1; j < ls.length; j++) {
            if (!ls[j]) continue;
            if (ls[j].startsWith('#')) {
              if (ls[j].startsWith('#EXT-X-STREAM-INF')) break;
              continue;
            }
            uri = ls[j];
            i = j;
            break;
          }
          if (!uri) continue;
          const url = VG.resolveUrl(uri, baseUrl);
          if (seen.has(url)) continue;
          seen.add(url);
          const [w, h] = String(a.RESOLUTION || '')
            .split('x')
            .map(Number);
          variants.push({
            url,
            bandwidth: +a.BANDWIDTH || 0,
            avgBandwidth: +a['AVERAGE-BANDWIDTH'] || 0,
            width: w || 0,
            height: h || 0,
            codecs: a.CODECS || '',
            fps: parseFloat(a['FRAME-RATE']) || 0,
            videoRange: a['VIDEO-RANGE'] || '',
            supplementalCodecs: a['SUPPLEMENTAL-CODECS'] || '',
            audioGroup: a.AUDIO || '',
          });
        } else if (l.startsWith('#EXT-X-MEDIA:')) {
          const a = VG.parseAttrList(l.slice(13));
          media.push({
            type: a.TYPE,
            groupId: a['GROUP-ID'] || '',
            name: a.NAME || '',
            language: a.LANGUAGE || '',
            url: a.URI ? VG.resolveUrl(a.URI, baseUrl) : null,
            isDefault: a.DEFAULT === 'YES',
            channels: a.CHANNELS || '',
          });
        }
      }
      return {
        variants,
        audio: media.filter((m) => m.type === 'AUDIO'),
        subs: media.filter((m) => m.type === 'SUBTITLES' && m.url),
      };
    },

    parseMedia(text, baseUrl) {
      const ls = lines(text);
      let seq = 0;
      let key = null;
      let map = null;
      let dur = 0;
      let br = null;
      let endList = false;
      let total = 0;
      const lastEnd = {};
      const segments = [];
      for (const l of ls) {
        if (!l) continue;
        if (l.startsWith('#')) {
          if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(l.slice(22), 10) || 0;
          else if (l.startsWith('#EXT-X-KEY:')) {
            const a = VG.parseAttrList(l.slice(11));
            if (a.METHOD === 'NONE') key = null;
            else
              key = {
                method: a.METHOD,
                uri: a.URI ? VG.resolveUrl(a.URI, baseUrl) : null,
                iv: a.IV || null,
                keyformat: a.KEYFORMAT || 'identity',
              };
          } else if (l.startsWith('#EXT-X-MAP:')) {
            const a = VG.parseAttrList(l.slice(11));
            map = { url: VG.resolveUrl(a.URI, baseUrl), range: parseByteRange(a.BYTERANGE, 0) };
          } else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8)) || 0;
          else if (l.startsWith('#EXT-X-BYTERANGE:')) br = l.slice(17);
          else if (l.startsWith('#EXT-X-ENDLIST')) endList = true;
          continue;
        }
        const url = VG.resolveUrl(l, baseUrl);
        let range = null;
        if (br) {
          range = parseByteRange(br, lastEnd[url]);
          lastEnd[url] = range.offset + range.length;
          br = null;
        }
        segments.push({ url, duration: dur, range, key: key ? { ...key, seq } : null, map });
        total += dur;
        seq++;
        dur = 0;
      }
      const drm = segments.some(
        (s) =>
          s.key &&
          (s.key.method !== 'AES-128' ||
            (s.key.keyformat && s.key.keyformat !== 'identity') ||
            !/^(https?|data):/i.test(s.key.uri || ''))
      );
      return { segments, endList, totalDuration: total, drm };
    },
  };

  if (typeof module !== 'undefined') module.exports = VG;
})(globalThis);
