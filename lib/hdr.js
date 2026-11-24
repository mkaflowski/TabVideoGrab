// Rozpoznawanie HDR na podstawie kodeków, VIDEO-RANGE, charakterystyki przenoszenia (CICP) i głębi bitowej.
(function (g) {
  const VG = (g.VG = g.VG || {});

  const DV_RE = /^(dvh1|dvhe|dav1|dva1|dvav|dva1)/i;
  // CICP TransferCharacteristics: 16 = PQ (SMPTE ST 2084), 18 = HLG (ARIB STD-B67)
  const SDR_TRANSFERS = [1, 4, 5, 6, 7, 8, 13, 14, 15];

  // Wyciąga informacje o kolorze z pojedynczego ciągu kodeka (RFC 6381).
  VG.parseCodecColor = function (codec) {
    const c = String(codec || '').trim();
    const lc = c.toLowerCase();
    const p = c.split('.');
    if (DV_RE.test(lc)) return { family: 'dv', dolby: true, bitDepth: 10 };
    if (/^(hvc1|hev1)/.test(lc)) {
      // hvc1.2.4.L153.B0 -> profil 2 = Main 10
      const prof = parseInt(String(p[1] || '').replace(/^[a-c]/i, ''), 10);
      return { family: 'hevc', bitDepth: prof === 2 ? 10 : prof === 1 ? 8 : undefined };
    }
    if (/^av01/.test(lc)) {
      // av01.P.LLT.DD.M.CCC.cp.tc.mc.F
      const depth = parseInt(p[3], 10);
      const tc = p[7] !== undefined ? parseInt(p[7], 10) : undefined;
      return { family: 'av1', bitDepth: depth || undefined, transfer: isNaN(tc) ? undefined : tc };
    }
    if (/^vp09/.test(lc)) {
      // vp09.PP.LL.DD.CC.cp.tc.mc.FF
      const depth = parseInt(p[3], 10);
      const tc = p[6] !== undefined ? parseInt(p[6], 10) : undefined;
      return { family: 'vp9', bitDepth: depth || undefined, transfer: isNaN(tc) ? undefined : tc };
    }
    if (lc === 'vp8') return { family: 'vp8', bitDepth: 8 };
    if (/^(avc1|avc3)/.test(lc)) {
      const prof = parseInt((p[1] || '').slice(0, 2), 16);
      return { family: 'avc', bitDepth: prof === 110 ? 10 : 8 };
    }
    return { family: 'other' };
  };

  // Zwraca { label, short, isHdr: true|false|null, detail }
  VG.classifyHdr = function (o) {
    o = o || {};
    let dolby = !!o.dolby;
    let depth = o.bitDepth || 0;
    let transfer = o.transfer;
    for (const c of String(o.codecs || '').split(',')) {
      if (!c.trim()) continue;
      const p = VG.parseCodecColor(c);
      if (VG.isAudioOnlyCodecs && VG.isAudioOnlyCodecs(c)) continue;
      if (p.dolby) dolby = true;
      if (p.bitDepth && p.bitDepth > depth) depth = p.bitDepth;
      if ((transfer === undefined || transfer === null) && p.transfer !== undefined) transfer = p.transfer;
    }
    for (const c of String(o.supplementalCodecs || '').split(',')) {
      if (DV_RE.test(c.trim())) dolby = true;
    }
    const vr = String(o.videoRange || '').toUpperCase();
    let base = null;
    if (vr === 'PQ' || transfer === 16) base = 'HDR10';
    else if (vr === 'HLG' || transfer === 18) base = 'HLG';

    if (dolby) {
      return {
        label: 'Dolby Vision',
        short: 'DV',
        isHdr: true,
        detail: 'Dolby Vision' + (base ? ` (warstwa bazowa ${base})` : ''),
      };
    }
    if (base === 'HDR10')
      return { label: 'HDR10', short: 'HDR10', isHdr: true, detail: 'HDR – PQ (SMPTE ST 2084)' };
    if (base === 'HLG') return { label: 'HLG', short: 'HLG', isHdr: true, detail: 'HDR – HLG (ARIB STD-B67)' };
    if (o.hdrMeta)
      return depth >= 10
        ? { label: 'HDR10', short: 'HDR10', isHdr: true, detail: 'HDR10 – 10-bit z metadanymi mastering display / MaxCLL' }
        : { label: 'HDR', short: 'HDR', isHdr: true, detail: 'HDR – metadane mastering display / MaxCLL' };
    if (vr === 'SDR') return { label: 'SDR', short: 'SDR', isHdr: false, detail: 'Playlista deklaruje VIDEO-RANGE=SDR' };
    if (typeof transfer === 'number' && SDR_TRANSFERS.includes(transfer))
      return { label: 'SDR', short: 'SDR', isHdr: false, detail: 'Charakterystyka BT.709/BT.601 (SDR)' };
    const bt2020 = o.primaries === 9 || o.matrix === 9 || o.matrix === 10;
    if (depth >= 10 || bt2020)
      return {
        label: depth >= 10 ? '10-bit' : 'BT.2020',
        short: '10bit',
        isHdr: null,
        detail: (depth >= 10 ? '10-bit' : 'Paleta BT.2020') + ' bez informacji o krzywej HDR – może być HDR lub SDR',
      };
    if (depth === 8) return { label: 'SDR', short: 'SDR', isHdr: false, detail: '8-bit – SDR' };
    return { label: '?', short: '', isHdr: null, detail: 'Brak informacji o zakresie dynamiki' };
  };

  if (typeof module !== 'undefined') module.exports = VG;
})(globalThis);
