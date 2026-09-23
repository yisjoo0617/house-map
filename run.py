"""Start House-Map and open it in the browser once the server is ready.

Used by start.bat / start.sh. Options: --no-browser, --port N (default 8000).
"""
import socket
import sys
import threading
import time
import webbrowser

import uvicorn

HOST = "127.0.0.1"
PORT = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else 8000


def port_in_use(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex((HOST, port)) == 0


def open_when_ready(url: str) -> None:
    for _ in range(100):
        if port_in_use(PORT):
            webbrowser.open(url)
            return
        time.sleep(0.2)


if __name__ == "__main__":
    url = f"http://localhost:{PORT}"
    if port_in_use(PORT):
        print(f"House-Map이 이미 실행 중입니다: {url}")
        webbrowser.open(url)
        sys.exit(0)
    print(f"House-Map 실행 중: {url}  (종료: 이 창을 닫거나 Ctrl+C)")
    if "--no-browser" not in sys.argv:
        threading.Thread(target=open_when_ready, args=(url,), daemon=True).start()
    uvicorn.run("app.main:app", host=HOST, port=PORT, log_level="warning")
