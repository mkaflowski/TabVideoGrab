'use strict';
/* global VG */

const esc = VG.escapeHtml;
const $list = document.getElementById('list');
const $jobs = document.getElementById('jobs');
let tabId = null;
let lastJobsHtml = '';
let lastListHtml = '';
let nativeState = { state: 'unknown' };
const nativeOk = () => nativeState.state === 'ok' && !!nativeState.ytdlp;
// Wybór ścieżki dźwiękowej i napisów – zapamiętywany per adres filmu
let choices = {};
try {
  choices = JSON.parse(localStorage.getItem('vg-choices') || '{}') || {};
} catch (e) {}
const saveChoices = () => {
  try {
    const keys = Object.keys(choices);
    if (keys.length > 200) delete choices[keys[0]];
    localStorage.setItem('vg-choices', JSON.stringify(choices));
  } catch (e) {}
};
const choiceFor = (item) => {
  const c = choices[item.url] || {};
  const audio = item.audioTracks.some((t) => t.id === c.audio) ? c.audio : '';
  const sub = item.subTracks.some((t) => t.id === c.sub) ? c.sub : '';
  return { audio, sub };
};

// Uruchamiane w folderze dodatku (tym, z którego wczytano manifest.json)
const INSTALL_CMD = 'powershell -ExecutionPolicy Bypass -File .\\host\\install.ps1';

function hdrBadge(h) {
  if (!h) return '';
  let cls = 'unk';
  if (h.isHdr === true) cls = h.short === 'DV' ? 'dv' : h.short === 'HLG' ? 'hlg' : 'hdr10';
  else if (h.isHdr === false) cls = 'sdr';
  else if (h.short === '10bit') cls = 'maybe';
  const text = h.label === '?' ? 'HDR?' : h.label;
  return `<span class="badge ${cls}" title="${esc(h.detail)}">${esc(text)}</span>`;
}

function optionRow(item, o) {
  const l1 = [];
  if (o.audioOnly) l1.push('Tylko dźwięk');
  else if (o.width && o.height) l1.push(`${o.width}×${o.height}${o.fromPlayer ? ' (z odtwarzacza)' : ''}`);
  else l1.push('Rozdzielczość nieznana');
  if (o.fps) l1.push(`${Math.round(o.fps * 100) / 100} fps`);
  const l2 = [];
  const codec = VG.codecName(o.codecs);
  if (codec) l2.push(codec);
  if (o.bandwidth) l2.push(VG.formatBitrate(o.bandwidth));
  if (o.size) l2.push((o.sizeExact ? '' : '~') + VG.formatBytes(o.size));
  if (o.audio && o.audio.language && !o.audioOnly) l2.push('audio: ' + o.audio.language);
  else if (o.audio && o.audioOnly && (o.audio.language || o.audio.name)) l2.push(o.audio.name || o.audio.language);

  if (o.auto) {
    l1.length = 0;
    l2.length = 0;
    l1.push('Najwyższa dostępna jakość + najlepszy dźwięk');
    l2.push('wybór należy do yt-dlp');
  }
  const q = o.audioOnly ? 'Audio' : o.auto ? 'Najlepsza' : esc(o.label).replace(/\s*\((.*)\)/, '<small>$1</small>');
  const yt = item.kind === 'youtube';
  const disabled = o.drm || item.status !== 'ready' || (yt && !nativeOk());
  const title = o.drm
    ? 'Zabezpieczone DRM'
    : yt && !nativeOk()
    ? 'Wymaga programu pomocniczego z yt-dlp – zainstaluj go albo skopiuj komendę obok'
    : 'Pobierz tę wersję';
  const copy = yt ? `<button class="ghost icon" data-ytcmd="${item.id}|${o.id}" title="Kopiuj komendę yt-dlp (z wybranym dźwiękiem i napisami)">⧉</button>` : '';
  return `<div class="opt">
    <div class="q">${q}</div>
    <div class="det"><div class="l1">${esc(l1.join(' · '))}</div><div>${esc(l2.join(' · '))}</div></div>
    ${o.audioOnly ? '' : o.auto ? '' : hdrBadge(o.hdr)}
    ${copy}<button data-dl="${item.id}|${o.id}" ${disabled ? 'disabled' : ''} title="${title}">${o.drm ? 'DRM' : 'Pobierz'}</button>
  </div>`;
}

function tracksRow(item) {
  const c = choiceFor(item);
  const parts = [];
  if (item.audioTracks.length) {
    const def = item.audioTracks.find((t) => t.isDefault);
    const opts = item.audioTracks
      .map((t) => {
        const sel = c.audio ? c.audio === t.id : def ? def.id === t.id : false;
        return `<option value="${esc(t.id)}"${sel ? ' selected' : ''}>${esc(t.label)}${t.isDefault ? ' – domyślna' : ''}</option>`;
      })
      .join('');
    parts.push(`<label>Dźwięk<select data-audio="${item.id}" data-url="${esc(item.url)}">${opts}</select></label>`);
  }
  if (item.subTracks.length) {
    const opts =
      `<option value="">Bez napisów</option>` +
      item.subTracks.map((t) => `<option value="${esc(t.id)}"${c.sub === t.id ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
    parts.push(`<label>Napisy<select data-sub="${item.id}" data-url="${esc(item.url)}">${opts}</select></label>`);
  }
  return parts.length ? `<div class="tracks">${parts.join('')}</div>` : '';
}

const MAX_ENTRIES = 150;
const entryFilter = {}; // filtr nazw per lista (tylko w tym okienku)

function entriesList(item) {
  const f = (entryFilter[item.id] || '').toLowerCase();
  const all = item.entries || [];
  const shown = all.filter((e) => !f || (e.name + ' ' + e.group + ' ' + e.url).toLowerCase().includes(f));
  const rows = shown
    .slice(0, MAX_ENTRIES)
    .map(
      (e) => `<div class="opt entry">
      <div class="det"><div class="l1">${esc(e.name || VG.fileNameFromUrl(e.url) || e.url)}</div><div>${esc(e.group ? e.group + ' · ' : '')}${esc(e.url)}</div></div>
      <button class="ghost icon" data-copy="${esc(e.url)}" title="Kopiuj adres">⧉</button>
      <button data-analyze="${item.id}|${e.id}" ${e.added ? 'disabled' : ''} title="Sprawdź jakości i HDR tej pozycji">${e.added ? 'Dodano ↑' : 'Analizuj'}</button>
    </div>`
    )
    .join('');
  const search = all.length > 8 ? `<div class="tracks"><input class="filter" data-filter="${item.id}" placeholder="Szukaj na liście (${all.length})…" value="${esc(entryFilter[item.id] || '')}"></div>` : '';
  const more = shown.length > MAX_ENTRIES ? `<div class="notes"><div class="note">…i ${shown.length - MAX_ENTRIES} więcej – zawęź wyszukiwanie.</div></div>` : '';
  return search + `<div class="opts">${rows}</div>` + more;
}

function itemCard(item) {
  const kindLabel =
    item.kind === 'hls'
      ? 'HLS'
      : item.kind === 'dash'
      ? 'DASH'
      : item.kind === 'youtube'
      ? 'YOUTUBE'
      : item.kind === 'm3u'
      ? 'M3U'
      : (item.container || 'PLIK').toUpperCase();
  const meta = [];
  if (item.duration) meta.push(VG.formatDuration(item.duration));
  if (item.live) meta.push('NA ŻYWO');
  const vids = item.options.filter((o) => !o.audioOnly);
  if (vids.length > 1) meta.push(`${vids.length} wersji`);
  if (item.kind === 'youtube') {
    if (item.loadingMore) meta.push('<span class="spin"></span> yt-dlp sprawdza formaty…');
    else if (item.source === 'ytdlp') meta.push('formaty: yt-dlp');
    else if (item.source === 'page') meta.push('formaty: strona');
  }
  if (vids.some((o) => o.hdr && o.hdr.isHdr)) meta.push('<span class="hdr-yes">HDR dostępne</span>');
  else if (vids.length && vids.every((o) => o.hdr && o.hdr.isHdr === false)) meta.push('tylko SDR');
  const metaHtml = meta.map((m) => (m.startsWith('<') ? m : esc(m))).join(' · ');

  let body = '';
  if (item.status === 'parsing') body = `<div class="notes"><span class="spin"></span> Analizowanie…</div>`;
  else if (item.status === 'error') body = `<div class="notes"><div class="note err">Błąd: ${esc(item.error)}</div></div>`;
  else {
    const list = (item.notes || []).slice();
    if (item.moreError) list.push('yt-dlp: ' + item.moreError);
    const notes = list.map((n) => `<div class="note">${esc(n)}</div>`).join('');
    body = (notes ? `<div class="notes">${notes}</div>` : '') + tracksRow(item) + `<div class="opts">${item.options.map((o) => optionRow(item, o)).join('')}</div>`;
    if (item.kind === 'm3u') body = (notes ? `<div class="notes">${notes}</div>` : '') + entriesList(item);
  }
  return `<div class="item ${item.status}">
    <div class="item-head">
      <div class="item-top"><span class="kind ${item.kind}">${esc(kindLabel)}</span>
        <div class="item-title" title="${esc(item.url)}">${esc(item.title || VG.fileNameFromUrl(item.url) || item.url)}</div></div>
      <div class="item-meta">${metaHtml}${metaHtml ? ' · ' : ''}<button class="link" data-copy="${esc(item.url)}">kopiuj URL</button></div>
    </div>${body}</div>`;
}

function jobCard(j) {
  const pct = Math.round((j.progress || 0) * 100);
  let sub = '';
  if (j.status === 'running') {
    sub = `${esc(j.phase)} · ${pct}%` + (j.bytes ? ` · ${VG.formatBytes(j.bytes)}` : '') + (j.speed ? ` · ${VG.formatBytes(j.speed)}/s` : '');
  } else if (j.status === 'done') sub = `<span class="ok">Zapisano:</span> ${esc(j.files.join(', '))}`;
  else if (j.status === 'error') sub = `<span class="err">Błąd: ${esc(j.error)}</span>`;
  else sub = 'Anulowano';
  const cmd =
    j.status === 'done' && j.note
      ? `<div class="cmd"><code title="${esc(j.note)}">${esc(j.note)}</code><button class="ghost" data-copy="${esc(j.note)}">Kopiuj</button></div>`
      : '';
  const reveal = j.status === 'done' && j.canReveal ? `<div class="cmd"><button class="link" data-reveal="${j.id}">Pokaż w folderze</button></div>` : '';
  return `<div class="job ${j.status}">
    <div class="job-top"><div class="job-title" title="${esc(j.title)}">${esc(j.title)} <span style="color:var(--muted)">· ${esc(j.label)}</span></div>
    ${j.status === 'running' ? `<button class="ghost" data-cancel="${j.id}">Anuluj</button>` : ''}</div>
    <div class="bar"><i style="width:${j.status === 'running' ? pct : 100}%"></i></div>
    <div class="job-sub">${sub}</div>${cmd}${reveal}</div>`;
}

async function refresh() {
  if (tabId === null) return;
  let state;
  try {
    state = await browser.runtime.sendMessage({ type: 'state', tabId });
  } catch (e) {
    return;
  }
  const jobsHtml = state.jobs.length
    ? `<div class="jobs-head"><span>Pobierania</span>${
        state.jobs.some((j) => j.status !== 'running') ? '<button class="link" data-clearjobs>wyczyść zakończone</button>' : ''
      }</div>` + state.jobs.map(jobCard).join('')
    : '';
  if (jobsHtml !== lastJobsHtml) {
    $jobs.innerHTML = jobsHtml;
    lastJobsHtml = jobsHtml;
  }
  nativeState = state.native || { state: 'unknown' };
  const hasYt = state.items.some((i) => i.kind === 'youtube');
  let banner = '';
  if (hasYt && !nativeOk()) {
    const why =
      nativeState.state === 'ok'
        ? 'Program pomocniczy działa, ale nie znalazł <b>yt-dlp</b>. Zainstaluj: <code>winget install yt-dlp.yt-dlp</code> i uruchom ponownie Firefoksa.'
        : nativeState.state === 'connecting' || nativeState.state === 'unknown'
        ? 'Łączenie z programem pomocniczym…'
        : 'Aby pobierać z YouTube jednym kliknięciem, zainstaluj program pomocniczy (raz) – uruchom poniższą komendę w folderze dodatku. Do tego czasu możesz skopiować komendę yt-dlp przyciskiem ⧉.';
    const btn = nativeState.state === 'missing' ? `<div class="cmd"><code>${esc(INSTALL_CMD)}</code><button class="ghost" data-copy="${esc(INSTALL_CMD)}">Kopiuj</button></div>` : '';
    banner = `<div class="banner">${why}${btn}</div>`;
  }
  const listHtml = state.items.length
    ? banner + state.items.map(itemCard).join('') +
      '<div class="foot">Najedź na znaczek HDR, aby zobaczyć szczegóły. Treści z DRM (Netflix, Disney+ itp.) nie da się pobrać.</div>'
    : `<div class="empty"><b>Nie wykryto wideo</b>Uruchom odtwarzanie filmu na stronie – pojawi się tutaj.<br>Jeśli strona była otwarta przed instalacją dodatku, odśwież ją.</div>`;
  if (listHtml !== lastListHtml) {
    $list.innerHTML = listHtml;
    lastListHtml = listHtml;
  }
}

// Aktualny wybór z list rozwijanych danej pozycji
function currentChoice(itemId) {
  const a = document.querySelector(`select[data-audio="${itemId}"]`);
  const s = document.querySelector(`select[data-sub="${itemId}"]`);
  return { audioId: a ? a.value : '', subId: s ? s.value : '' };
}

document.addEventListener('input', (e) => {
  const el = e.target;
  if (!el.matches('input[data-filter]')) return;
  entryFilter[el.dataset.filter] = el.value;
  lastListHtml = '';
  refresh().then(() => {
    const again = document.querySelector(`input[data-filter="${el.dataset.filter}"]`);
    if (again) {
      again.focus();
      again.setSelectionRange(again.value.length, again.value.length);
    }
  });
});

document.addEventListener('change', (e) => {
  const el = e.target;
  if (!el.matches('select[data-audio], select[data-sub]')) return;
  const url = el.dataset.url;
  choices[url] = choices[url] || {};
  if (el.dataset.audio) choices[url].audio = el.value;
  else choices[url].sub = el.value;
  saveChoices();
  lastListHtml = '';
  refresh();
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.dl) {
    const [itemId, optionId] = b.dataset.dl.split('|');
    b.disabled = true;
    const r = await browser.runtime.sendMessage({ type: 'download', tabId, itemId, optionId, ...currentChoice(itemId) });
    if (r && r.error) alert(r.error);
  } else if (b.dataset.ytcmd) {
    const [itemId, optionId] = b.dataset.ytcmd.split('|');
    const cmd = await browser.runtime.sendMessage({ type: 'yt-command', tabId, itemId, optionId, ...currentChoice(itemId) });
    try {
      await navigator.clipboard.writeText(cmd);
      b.textContent = '✓';
      setTimeout(() => (b.textContent = '⧉'), 1200);
    } catch (err) {
      prompt('Skopiuj komendę:', cmd);
    }
    return;
  } else if (b.dataset.analyze) {
    const [itemId, entryId] = b.dataset.analyze.split('|');
    b.disabled = true;
    b.textContent = '…';
    const r = await browser.runtime.sendMessage({ type: 'analyze-entry', tabId, itemId, entryId });
    if (r && r.error) alert(r.error);
  } else if (b.dataset.cancel) {
    await browser.runtime.sendMessage({ type: 'cancel', jobId: b.dataset.cancel });
  } else if (b.dataset.copy !== undefined) {
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      const t = b.textContent;
      b.textContent = 'skopiowano ✓';
      setTimeout(() => (b.textContent = t), 1200);
    } catch (err) {}
    return;
  } else if (b.dataset.reveal) {
    await browser.runtime.sendMessage({ type: 'reveal', jobId: b.dataset.reveal });
  } else if (b.hasAttribute('data-clearjobs')) {
    await browser.runtime.sendMessage({ type: 'clear-jobs' });
  } else if (b.id === 'clear') {
    await browser.runtime.sendMessage({ type: 'clear-tab', tabId });
  }
  lastJobsHtml = lastListHtml = '';
  refresh();
});

(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  refresh();
  setInterval(refresh, 700);
})();
