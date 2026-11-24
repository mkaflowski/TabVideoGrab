// Zgłasza elementy <video> ze strony (źródło i rzeczywista rozdzielczość odtwarzacza)
// oraz – na YouTube – listę formatów z danych odtwarzacza.
(function () {
  if (window.__tabVideoGrabContent) return;
  window.__tabVideoGrabContent = true;

  const send = (msg) => browser.runtime.sendMessage(msg).catch(() => {});

  // ---------------- zwykłe <video> ----------------
  let last = '';
  let timer = null;

  function report() {
    timer = null;
    const videos = Array.from(document.querySelectorAll('video'))
      .map((v) => ({
        src: v.currentSrc || v.src || '',
        w: v.videoWidth || 0,
        h: v.videoHeight || 0,
        duration: isFinite(v.duration) ? v.duration : 0,
      }))
      .filter((v) => v.src);
    if (videos.length) {
      const key = JSON.stringify(videos);
      if (key !== last) {
        last = key;
        send({ type: 'dom-videos', videos });
      }
    }
    if (isYouTube) checkYouTube();
  }

  const schedule = () => {
    if (!timer) timer = setTimeout(report, 300);
  };
  document.addEventListener('loadedmetadata', schedule, true);
  document.addEventListener('resize', schedule, true); // zmiana rozdzielczości strumienia adaptacyjnego

  // ---------------- YouTube ----------------
  const isYouTube = /(^|\.)(youtube\.com|youtube-nocookie\.com)$/.test(location.hostname);
  let ytSent = '';

  function ytVideoId() {
    const u = new URL(location.href);
    if (u.searchParams.get('v')) return u.searchParams.get('v');
    const m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname);
    return m ? m[1] : '';
  }

  // Dane odtwarzacza ze strony (Firefox: wrappedJSObject daje dostęp do zmiennych strony)
  function ytPlayerResponse() {
    const w = window.wrappedJSObject || window;
    const tries = [
      () => {
        const p = document.getElementById('movie_player');
        const pw = p && (p.wrappedJSObject || p);
        return pw && typeof pw.getPlayerResponse === 'function' ? pw.getPlayerResponse() : null;
      },
      () => w.ytInitialPlayerResponse,
    ];
    for (const t of tries) {
      try {
        const pr = t();
        if (pr) return JSON.parse(w.JSON.stringify(pr));
      } catch (e) {}
    }
    return null;
  }

  function checkYouTube() {
    const id = ytVideoId();
    if (!id) return;
    const pr = ytPlayerResponse();
    const prId = pr && pr.videoDetails && pr.videoDetails.videoId;
    const key = id + '|' + (prId === id ? 'pr' : 'id');
    if (key === ytSent) return;
    ytSent = key;
    if (prId === id) send({ type: 'yt-video', id, playerResponse: slimPlayerResponse(pr) });
    else send({ type: 'yt-video', id, playerResponse: null }); // tło pobierze stronę filmu samo
  }

  function slimPlayerResponse(pr) {
    const sd = pr.streamingData || {};
    const pick = (f) => ({
      itag: f.itag,
      mimeType: f.mimeType,
      width: f.width,
      height: f.height,
      fps: f.fps,
      bitrate: f.bitrate,
      averageBitrate: f.averageBitrate,
      contentLength: f.contentLength,
      qualityLabel: f.qualityLabel,
      colorInfo: f.colorInfo,
      audioTrack: f.audioTrack,
      isDrc: f.isDrc,
      audioChannels: f.audioChannels,
      approxDurationMs: f.approxDurationMs,
    });
    const ps = pr.playabilityStatus || {};
    return {
      videoDetails: {
        videoId: pr.videoDetails.videoId,
        title: pr.videoDetails.title,
        lengthSeconds: pr.videoDetails.lengthSeconds,
        isLive: pr.videoDetails.isLive,
      },
      playabilityStatus: { status: ps.status, reason: ps.reason },
      streamingData: { adaptiveFormats: (sd.adaptiveFormats || []).map(pick) },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: (
            (pr.captions && pr.captions.playerCaptionsTracklistRenderer && pr.captions.playerCaptionsTracklistRenderer.captionTracks) ||
            []
          ).map((c) => ({ languageCode: c.languageCode, name: c.name, kind: c.kind })),
        },
      },
    };
  }

  if (isYouTube) {
    document.addEventListener('yt-navigate-finish', () => setTimeout(checkYouTube, 500));
    document.addEventListener('yt-page-data-updated', () => setTimeout(checkYouTube, 500));
    let href = location.href;
    setInterval(() => {
      if (location.href !== href) {
        href = location.href;
        setTimeout(checkYouTube, 800);
      }
    }, 1000);
  }

  schedule();
  setTimeout(schedule, 3000);
})();
