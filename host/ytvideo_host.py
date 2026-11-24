"""Native messaging host: downloads a YouTube video in the best quality with yt-dlp + ffmpeg.

Chrome starts one host process per port. The first message picks the job:
  {"type": "ping"}                     -> {"type": "pong", "ytdlp": "<version>"}
  {"type": "download", "videoId": "…"} -> stream of {"type": "info"|"progress"|"done"|"error", …}
  {"type": "reveal", "path": "…"}      -> shows the file in Finder
When the extension disconnects (user cancelled), stdin closes and the download is stopped.
"""

import json
import os
import re
import glob
import shutil
import signal
import struct
import subprocess
import sys
import threading

# Chrome starts hosts with a bare PATH; add Homebrew so yt-dlp can find ffmpeg.
os.environ["PATH"] = os.pathsep.join(
    ["/opt/homebrew/bin", "/usr/local/bin", os.environ.get("PATH", "/usr/bin:/bin")]
)

DOWNLOAD_DIR = os.path.expanduser("~/Downloads")
ID_RE = re.compile(r"^[\w-]{11}$")
_out_lock = threading.Lock()


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack("=I", raw)
    return json.loads(sys.stdin.buffer.read(length))


def send(msg):
    data = json.dumps(msg).encode()
    with _out_lock:
        try:
            sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
            sys.stdout.buffer.flush()
        except OSError:
            pass  # extension already disconnected (cancelled); keep going so we can clean up


def ytdlp():
    path = shutil.which("yt-dlp")
    if not path:
        raise RuntimeError("yt-dlp not found. Install it with: brew install yt-dlp ffmpeg")
    return path


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return 0.0


def download(video_id):
    if not ID_RE.match(video_id or ""):
        raise RuntimeError("Invalid video id")
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not found. Install it with: brew install ffmpeg")

    cmd = [
        ytdlp(),
        f"https://www.youtube.com/watch?v={video_id}",
        "--no-playlist",
        # Best video + best audio, merged. Falls back to the best single file.
        "-f", "bv*+ba/b",
        "--merge-output-format", "mp4",
        "-P", DOWNLOAD_DIR,
        "-o", "%(title).150B [%(id)s].%(ext)s",
        "--no-simulate",
        "--progress",
        "--newline",
        "--print", "before_dl:YTV_INFO\t%(title)s\t%(height)s\t%(fps)s\t%(vcodec)s\t%(width)s",
        "--print", "after_move:YTV_FILE\t%(filepath)s",
        "--progress-template",
        "download:YTV_PROG\t%(info.vcodec)s\t%(progress.downloaded_bytes)s\t%(progress.total_bytes,progress.total_bytes_estimate)s",
        "--progress-template",
        "postprocess:YTV_POST\t%(progress.postprocessor)s",
    ]
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        start_new_session=True,
    )

    cancelled = threading.Event()

    def stop(*_):
        cancelled.set()
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)

    # Extension disconnected (cancel / tab closed) -> stdin EOF. Chrome may also SIGTERM us.
    def watch_stdin():
        while read_message() is not None:
            pass
        stop()

    threading.Thread(target=watch_stdin, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)

    errors = []

    def collect_stderr():
        for line in proc.stderr:
            if line.startswith("ERROR"):
                errors.append(line.strip())

    threading.Thread(target=collect_stderr, daemon=True).start()

    # Video part is ~90% of the bytes; audio the rest; merging the last step.
    filepath = None
    last_pct = -1
    for line in proc.stdout:
        parts = line.rstrip("\n").split("\t")
        tag = parts[0]
        if tag == "YTV_INFO" and len(parts) >= 6:
            send({"type": "info", "title": parts[1], "height": parts[2], "fps": parts[3], "vcodec": parts[4], "width": parts[5]})
        elif tag == "YTV_PROG" and len(parts) >= 4:
            is_video = parts[1] not in ("none", "NA", "")
            done, total = num(parts[2]), num(parts[3])
            frac = min(done / total, 1.0) if total else 0.0
            pct = int(frac * 90) if is_video else 90 + int(frac * 8)
            if pct != last_pct:
                last_pct = pct
                send({"type": "progress", "percent": pct, "phase": "video" if is_video else "audio"})
        elif tag == "YTV_POST":
            send({"type": "progress", "percent": 99, "phase": "merging"})
        elif tag == "YTV_FILE" and len(parts) >= 2:
            filepath = parts[1]

    code = proc.wait()
    if cancelled.is_set():
        remove_partial_files(video_id)
        return
    if code != 0 or not filepath:
        raise RuntimeError(errors[-1] if errors else f"yt-dlp exited with code {code}")
    send({"type": "done", "path": filepath, "name": os.path.basename(filepath)})


def remove_partial_files(video_id):
    """Delete what a cancelled run leaves behind; never touches a finished '<title> [id].<ext>'."""
    tag = glob.escape(f"[{video_id}]")
    pats = [f"*{tag}.f*", f"*{tag}*.part", f"*{tag}*.ytdl", f"*{tag}.temp.*"]
    for pat in pats:
        for f in glob.glob(os.path.join(DOWNLOAD_DIR, pat)):
            try:
                os.remove(f)
            except OSError:
                pass


def reveal(path):
    real = os.path.realpath(path or "")
    if not real.startswith(os.path.realpath(DOWNLOAD_DIR) + os.sep) or not os.path.isfile(real):
        raise RuntimeError("File not found")
    subprocess.run(["open", "-R", real], check=False)
    send({"type": "revealed"})


def main():
    msg = read_message()
    if not msg:
        return
    try:
        kind = msg.get("type")
        if kind == "ping":
            out = subprocess.run([ytdlp(), "--version"], capture_output=True, text=True)
            send({"type": "pong", "ytdlp": out.stdout.strip(), "ffmpeg": bool(shutil.which("ffmpeg"))})
        elif kind == "download":
            download(msg.get("videoId"))
        elif kind == "reveal":
            reveal(msg.get("path"))
        else:
            raise RuntimeError(f"Unknown message type: {kind}")
    except Exception as e:  # noqa: BLE001 - report every failure to the extension
        send({"type": "error", "error": str(e)})


if __name__ == "__main__":
    main()
    # The stdin watcher thread may still be blocked on read; exit without joining it.
    os._exit(0)
