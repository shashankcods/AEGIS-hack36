"""Start the local API, result consumer, and portable analytics worker."""

import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import time
from urllib.parse import urlparse
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
RUNTIME = ROOT / ".runtime"


def available_port(host, port):
    with socket.socket() as connection:
        connection.settimeout(0.5)
        return connection.connect_ex((host, port)) != 0


def runtime_python():
    candidates = [os.getenv("AEGIS_PYTHON")] + [
        str(ROOT / folder / "bin" / "python") for folder in (".venv", "venv", ".venv-ml")
    ] + [sys.executable]
    check = "import importlib.util; import sys; sys.exit(not all(importlib.util.find_spec(x) for x in ['django','rest_framework','redis','torch','transformers','gliner','PIL']))"
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            if subprocess.run([candidate, "-c", check], capture_output=True).returncode == 0:
                return candidate
    raise RuntimeError("No complete backend environment found. Create .venv and install requirements.txt.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--skip-ocr-warmup", action="store_true")
    parser.add_argument("--no-warmup", action="store_true")
    args = parser.parse_args()
    python = runtime_python()
    if not available_port("127.0.0.1", args.port):
        raise RuntimeError(f"Port {args.port} is already in use. Stop that server or choose --port.")
    RUNTIME.mkdir(exist_ok=True)
    environment = os.environ.copy()
    environment["TOKENIZERS_PARALLELISM"] = "false"
    environment["PYTHONUNBUFFERED"] = "1"
    environment["PYTHONPATH"] = str(BACKEND)
    redis_url = environment.get("AEGIS_REDIS_URL", "redis://127.0.0.1:6379/0")
    environment["AEGIS_REDIS_URL"] = redis_url
    children, logs = [], []

    def start(name, command):
        log = (RUNTIME / f"{name}.log").open("a", encoding="utf-8")
        logs.append(log)
        child = subprocess.Popen(command, cwd=BACKEND, env=environment,
                                 stdout=log, stderr=subprocess.STDOUT)
        children.append((name, child))
        print(f"Started {name} (PID {child.pid}); log: .runtime/{name}.log", flush=True)
        return child

    def check_children():
        for name, child in children:
            if child.poll() is not None:
                raise RuntimeError(f"{name} exited ({child.returncode}). Check .runtime/{name}.log.")

    try:
        ping = [python, "-c", "from ml_service.redis_client import get_redis_client; get_redis_client().ping()"]
        if subprocess.run(ping, cwd=BACKEND, env=environment, capture_output=True).returncode:
            address = urlparse(redis_url)
            if address.scheme != "redis" or address.hostname not in ("localhost", "127.0.0.1") or address.username or address.password:
                raise RuntimeError("Configured Redis is unavailable; start it before running the app.")
            server = shutil.which("redis-server")
            if not server:
                raise RuntimeError("Redis is unavailable. Install/start Redis, then run this command again.")
            if not available_port("127.0.0.1", address.port or 6379):
                raise RuntimeError("Redis port is occupied by an unavailable service; inspect it before restarting.")
            redis_dir = RUNTIME / f"redis-{address.port or 6379}"
            redis_dir.mkdir(exist_ok=True)
            start("redis", [server, "--bind", "127.0.0.1", "--port", str(address.port or 6379),
                            "--protected-mode", "yes", "--dir", str(redis_dir), "--dbfilename", "aegis.rdb",
                            "--appendonly", "yes", "--appendfilename", "aegis.aof"])
            for _ in range(20):
                check_children()
                if subprocess.run(ping, cwd=BACKEND, env=environment, capture_output=True).returncode == 0:
                    break
                time.sleep(0.2)
            else:
                raise RuntimeError("Local Redis did not become ready.")
        subprocess.run([python, str(BACKEND / "manage.py"), "check"], cwd=BACKEND,
                       env=environment, check=True)
        start("consumer", [python, "-m", "pathway_engine.consumer"])
        start("analytics", [python, "-m", "pathway_engine.analytics"])
        start("django", [python, "manage.py", "runserver", f"127.0.0.1:{args.port}", "--noreload"])
        base = f"http://127.0.0.1:{args.port}"
        for _ in range(60):
            check_children()
            try:
                with urlopen(base + "/api/health/", timeout=3) as response:
                    json.load(response)
                break
            except OSError:
                time.sleep(0.5)
        else:
            raise RuntimeError("Django did not become ready.")
        if not args.no_warmup:
            print("Loading V2 models and GLiNER" + (" + OCR…" if not args.skip_ocr_warmup else "…"), flush=True)
            url = base + "/api/health/?load=1" + ("" if args.skip_ocr_warmup else "&ocr=1")
            with urlopen(url, timeout=180) as response:
                health = json.load(response)
            if not health["text_analysis_ready"]:
                raise RuntimeError("Text models could not load. Check .runtime/django.log.")
        extension_note = "Load extension/dist in Chrome." if args.port == 8000 else "The extension uses port 8000; this custom port is for API testing."
        print(f"AEGIS API is running at {base}. {extension_note} Ctrl+C stops this stack.", flush=True)
        while True:
            check_children()
            time.sleep(1)
    except KeyboardInterrupt:
        print("Stopping the local AEGIS stack…", flush=True)
    finally:
        for _, child in reversed(children):
            if child.poll() is None:
                child.terminate()
        for _, child in reversed(children):
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        for log in logs:
            log.close()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError, OSError) as error:
        print(f"Startup failed: {error}", file=sys.stderr)
        sys.exit(1)
