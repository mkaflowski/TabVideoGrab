#!/usr/bin/env python3
"""Program pomocniczy TabVideoGrab (native messaging).

Firefox uruchamia go przez vg_host.bat. Komunikacja: 4 bajty długości (little-endian) + JSON (UTF-8).
Polecenia z dodatku:
  {"cmd": "ping"}
  {"cmd": "info", "id": "...", "url": "..."}                     -> lista formatów z `yt-dlp -J`
  {"cmd": "download", "id": "...", "url": "...", "format": "...", "output": "..."}
  {"cmd": "cancel", "id": "..."}
  {"cmd": "reveal", "path": "..."}                               -> pokazuje plik w Eksploratorze
"""
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import threading

VERSION = "1.0.0"
HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "config.json")
NO_WINDOW = 0x08000000 if os.name == "nt" else 0

if os.name == "nt":
    import msvcrt

    msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

_lock = threading.Lock()
_procs = {}


def send(msg):
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    with _lock:
        sys.stdout.buffer.write(struct.pack("<I", len(data)))
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    n = struct.unpack("<I", raw)[0]
    return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))


def load_config():
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def find_ytdlp():
    cfg = load_config()
    if cfg.get("ytdlp") and os.path.exists(cfg["ytdlp"]):
        return [cfg["ytdlp"]]
    exe = shutil.which("yt-dlp")
    if exe:
        return [exe]
    local = os.environ.get("LOCALAPPDATA", "")
    for c in [
        os.path.join(HERE, "yt-dlp.exe"),
        os.path.join(local, "Microsoft", "WinGet", "Links", "yt-dlp.exe"),
        os.path.join(os.path.expanduser("~"), "scoop", "shims", "yt-dlp.exe"),
        r"C:\ProgramData\chocolatey\bin\yt-dlp.exe",
    ]:
        if c and os.path.exists(c):
            return [c]
    try:
        import yt_dlp  # noqa: F401

        return [sys.executable, "-m", "yt_dlp"]
    except Exception:
        return None


def find_ffmpeg():
    cfg = load_config()
    if cfg.get("ffmpeg") and os.path.exists(cfg["ffmpeg"]):
        return cfg["ffmpeg"]
    return shutil.which("ffmpeg")


def downloads_dir():
    cfg = load_config()
    if cfg.get("outDir"):
        return os.path.expandvars(cfg["outDir"])
    if os.name == "nt":
        try:
            import winreg

            with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
            ) as k:
                v, _ = winreg.QueryValueEx(k, "{374DE290-123F-4565-9164-39C4925E467B}")
                return os.path.expandvars(v)
        except Exception:
            pass
    return os.path.join(os.path.expanduser("~"), "Downloads")


def ytdlp_version(cmd):
    try:
        r = subprocess.run(cmd + ["--version"], capture_output=True, text=True, timeout=30, creationflags=NO_WINDOW, stdin=subprocess.DEVNULL)
        return r.stdout.strip() or None
    except Exception:
        return None


def cookies_browser():
    # Ciasteczka zalogowanej sesji – używane tylko, gdy film wymaga zalogowania (Premium, wiek, prywatne).
    # config.json: "cookiesFromBrowser": "firefox" (domyślnie), "firefox:NAZWA_PROFILU" albo "" = wyłączone.
    v = load_config().get("cookiesFromBrowser", "firefox")
    return v or None


def always_cookies():
    # config.json: "cookiesMode": "always" – zawsze z zalogowaną sesją (np. format 1080p Premium)
    return load_config().get("cookiesMode") == "always" and bool(cookies_browser())


def find_js_runtime():
    """Środowisko JS dla yt-dlp (rozwiązywanie zabezpieczeń YouTube). deno yt-dlp znajduje sam."""
    cfg = load_config()
    if cfg.get("jsRuntime"):
        return cfg["jsRuntime"]  # np. "node:C:\\nodejs\\node.exe" albo "deno"
    if shutil.which("deno"):
        return None
    for name in ("node", "bun"):
        exe = shutil.which(name)
        if exe:
            return "%s:%s" % (name, exe)
    for c in (r"C:\Program Files\nodejs\node.exe", os.path.join(os.environ.get("ProgramFiles(x86)", ""), "nodejs", "node.exe")):
        if os.path.exists(c):
            return "node:" + c
    return None


YT_RE = re.compile(r"(^|[./])(youtube\.com|youtu\.be|youtube-nocookie\.com)/")
# Błędy, przy których warto spróbować ponownie z zalogowaną sesją Firefoksa
AUTH_RE = re.compile(
    r"premium|members|sign in|log in|login|private video|confirm your age|age-restricted|inappropriate|not a bot|cookies",
    re.I,
)


def base_args(cmd, url="", cookies=False):
    args = list(cmd) + ["--encoding", "utf-8", "--no-colors"]
    ff = find_ffmpeg()
    if ff:
        args += ["--ffmpeg-location", ff]
    js = find_js_runtime()
    if js:
        args += ["--js-runtimes", js]
    if cookies and cookies_browser() and YT_RE.search(url or ""):
        args += ["--cookies-from-browser", cookies_browser()]
    return args


TRAILER_ERR = "YouTube zwrócił zwiastun zamiast filmu – film wymaga dostępu (np. Premium) na koncie zalogowanym w Firefoksie"


def youtube_id(url):
    m = re.search(r"(?:[?&]v=|youtu\.be/|/(?:shorts|embed|live|v)/)([\w-]{11})", url or "")
    return m.group(1) if m else None


def can_retry_with_cookies(url, error, used):
    return (
        not used
        and bool(cookies_browser())
        and bool(YT_RE.search(url or ""))
        and bool(AUTH_RE.search(error or "") or error == TRAILER_ERR)
    )


def env():
    e = dict(os.environ)
    e["PYTHONIOENCODING"] = "utf-8"
    e["PYTHONUTF8"] = "1"
    return e


# ---------------------------------------------------------------- polecenia


def cmd_ping(msg):
    yt = find_ytdlp()
    send(
        {
            "type": "pong",
            "version": VERSION,
            "ytdlp": ytdlp_version(yt) if yt else None,
            "ffmpeg": bool(find_ffmpeg()),
            "outDir": downloads_dir(),
            "cookies": cookies_browser(),
            "jsRuntime": find_js_runtime() or ("deno" if shutil.which("deno") else None),
        }
    )


INFO_FORMAT_KEYS = [
    "format_id", "ext", "vcodec", "acodec", "width", "height", "fps", "tbr", "filesize",
    "filesize_approx", "dynamic_range", "format_note", "language", "language_preference",
    "audio_channels", "protocol",
]


def cmd_info(msg):
    yt = find_ytdlp()
    if not yt:
        send({"type": "info", "id": msg.get("id"), "error": "Nie znaleziono yt-dlp"})
        return
    try:
        cookies = bool(msg.get("cookies")) or always_cookies()
        while True:
            r = subprocess.run(
                base_args(yt, msg["url"], cookies) + ["-J", "--no-playlist", "--no-warnings", "--ignore-no-formats-error", msg["url"]],
                capture_output=True, timeout=180, creationflags=NO_WINDOW, env=env(), stdin=subprocess.DEVNULL,
            )
            out = r.stdout.decode("utf-8", "replace")
            if r.returncode == 0 and out.strip():
                want = youtube_id(msg["url"])
                try:
                    got = json.loads(out).get("id")
                except Exception:
                    got = None
                if not want or got == want:
                    break
                # yt-dlp podał zwiastun (inny film) zamiast filmu dostępnego tylko po zalogowaniu
                if can_retry_with_cookies(msg["url"], TRAILER_ERR, cookies):
                    cookies = True
                    continue
                send({"type": "info", "id": msg.get("id"), "error": TRAILER_ERR})
                return
            err = r.stderr.decode("utf-8", "replace").strip().splitlines()
            err = [l for l in err if "ERROR" in l] or err
            msg_err = err[-1] if err else "yt-dlp zakończył się błędem"
            if can_retry_with_cookies(msg["url"], msg_err, cookies):
                cookies = True
                continue
            send({"type": "info", "id": msg.get("id"), "error": msg_err})
            return
        info = json.loads(out)
        slim = {
            "id": info.get("id"),
            "title": info.get("title"),
            "duration": info.get("duration"),
            "is_live": info.get("is_live"),
            "formats": [{k: f.get(k) for k in INFO_FORMAT_KEYS} for f in info.get("formats") or []],
            "subtitles": {k: _sub_name(v, k) for k, v in (info.get("subtitles") or {}).items() if k != "live_chat"},
            # automatyczne: oryginalna ścieżka (-orig) + tłumaczenia na polski i angielski
            "automatic_captions": {
                k: _sub_name(v, k)
                for k, v in (info.get("automatic_captions") or {}).items()
                if k.endswith("-orig") or k in ("pl", "en")
            },
        }
        send({"type": "info", "id": msg.get("id"), "info": slim, "cookies": cookies})
    except Exception as e:  # noqa: BLE001
        send({"type": "info", "id": msg.get("id"), "error": str(e)})


def _sub_name(entries, lang):
    for e in entries or []:
        if e.get("name"):
            return e["name"]
    return lang


def _num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return 0.0


def cmd_download(msg):
    job = msg["id"]
    yt = find_ytdlp()
    if not yt:
        send({"type": "error", "id": job, "error": "Nie znaleziono yt-dlp – zainstaluj go (winget install yt-dlp)"})
        return
    out_dir = msg.get("outDir") or downloads_dir()
    cookies = bool(msg.get("cookies")) or always_cookies()
    send({"type": "started", "id": job, "outDir": out_dir})
    while True:
        code, files, error = _run_download(job, yt, msg, out_dir, cookies)
        if code is None:
            return  # anulowano / błąd uruchomienia – komunikat już wysłany
        if code != 0 and not files and can_retry_with_cookies(msg["url"], error, cookies):
            cookies = True
            send({"type": "phase", "id": job, "phase": "auth"})
            continue
        break
    if code == 0:
        send({"type": "done", "id": job, "files": files})
    else:
        send({"type": "error", "id": job, "error": error or "yt-dlp: kod %d" % code})


def _run_download(job, yt, msg, out_dir, cookies):
    args = base_args(yt, msg["url"], cookies) + [
        "--newline", "--no-playlist", "--progress",
        "-f", msg.get("format") or "bv*+ba/b",
        "-P", out_dir,
        "-o", msg.get("output") or "%(title)s [%(id)s].%(ext)s",
        "--progress-template",
        "download:VGPROG %(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|"
        "%(progress.total_bytes_estimate)s|%(progress.speed)s|%(info.format_id)s",
        "--print", "after_move:VGFILE %(filepath)s",
    ]
    vid = youtube_id(msg["url"])
    if vid:
        args += ["--match-filter", "id=%s" % vid]
    subs = msg.get("subs") or {}
    lang = re.sub(r"[^\w-]", "", str(subs.get("lang") or ""))
    if lang:
        args += ["--write-auto-subs" if subs.get("auto") else "--write-subs", "--sub-langs", lang, "--convert-subs", "srt"]
    args.append(msg["url"])
    # identyfikatory formatów z pierwszej alternatywy selektora (np. "337+251-1") – do liczenia części
    wanted = [re.sub(r"\[.*?\]", "", x) for x in (msg.get("format") or "").split("/")[0].split("+")]
    explicit = all(re.fullmatch(r"[\w-]+", w or "") and not w.startswith(("b", "w")) for w in wanted)
    try:
        p = subprocess.Popen(
            args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
            creationflags=NO_WINDOW, env=env(),
        )
    except Exception as e:  # noqa: BLE001
        send({"type": "error", "id": job, "error": str(e)})
        return None, [], ""
    _procs[job] = p
    tail, files, fmt_seen = [], [], []
    for raw in p.stdout:
        line = raw.decode("utf-8", "replace").rstrip("\r\n")
        if not line:
            continue
        if line.startswith("VGPROG "):
            st, done, total, est, speed, fid = (line[7:].split("|") + [""] * 6)[:6]
            if explicit:
                if fid not in wanted:
                    continue  # np. postęp pobierania napisów
                part = wanted.index(fid) + 1
            else:
                if not fid or fid in ("NA", "None"):
                    continue
                if fid not in fmt_seen:
                    fmt_seen.append(fid)
                part = fmt_seen.index(fid) + 1
            send({
                "type": "progress", "id": job, "status": st, "downloaded": _num(done),
                "total": _num(total) or _num(est), "speed": _num(speed), "format": fid,
                "part": part,
            })
        elif line.startswith("VGFILE "):
            files.append(line[7:])
        else:
            tail.append(line)
            del tail[:-20]
            if line.startswith("[Merger]") or line.startswith("[VideoConvertor]") or line.startswith("[ExtractAudio]"):
                send({"type": "phase", "id": job, "phase": "merge"})
    code = p.wait()
    _procs.pop(job, None)
    if getattr(p, "_vg_canceled", False):
        send({"type": "canceled", "id": job})
        return None, [], ""
    errs = [l for l in tail if "ERROR" in l] or tail[-3:]
    if code == 0 and not files and vid:  # --match-filter pominął inny film (zwiastun)
        return 1, [], TRAILER_ERR
    return code, files, "\n".join(errs)[-800:]


def cmd_cancel(msg):
    p = _procs.get(msg.get("id"))
    if not p:
        return
    p._vg_canceled = True
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, creationflags=NO_WINDOW)
    else:
        p.kill()


def cmd_reveal(msg):
    path = msg.get("path") or ""
    if os.name == "nt":
        if os.path.exists(path):
            subprocess.Popen('explorer /select,"%s"' % path)
        else:
            os.startfile(os.path.dirname(path) if os.path.dirname(path) else downloads_dir())


HANDLERS = {"ping": cmd_ping, "info": cmd_info, "download": cmd_download, "cancel": cmd_cancel, "reveal": cmd_reveal}


def main():
    while True:
        try:
            msg = read_message()
        except Exception:
            break
        if msg is None:
            break
        h = HANDLERS.get(msg.get("cmd"))
        if not h:
            send({"type": "error", "id": msg.get("id"), "error": "Nieznane polecenie"})
            continue
        if msg.get("cmd") in ("info", "download"):
            threading.Thread(target=h, args=(msg,), daemon=True).start()
        else:
            h(msg)
    for p in list(_procs.values()):
        p._vg_canceled = True
        if os.name == "nt":
            subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, creationflags=NO_WINDOW)
        else:
            p.kill()


if __name__ == "__main__":
    main()
