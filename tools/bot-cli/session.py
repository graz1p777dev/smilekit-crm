"""Общее для обоих окон отладчика: где сеанс и как с ним говорить.

Сервер (scripts/bot-cli-core.mts) слушает только 127.0.0.1 и пишет порт в
.session.json рядом с этим файлом. Оба окна читают один и тот же файл, поэтому
подключаются к одному и тому же сеансу.
"""

from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path
from typing import Any, Iterator

SESSION_FILE = Path(__file__).resolve().parent / ".session.json"


def wait_for_session(timeout: float = 30.0) -> dict[str, Any]:
    """Дождаться файла сеанса — окно отладки можно открыть и до чата."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if SESSION_FILE.exists():
            try:
                return json.loads(SESSION_FILE.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                pass
        time.sleep(0.3)
    raise SystemExit(
        "Сеанс отладчика не найден. Сначала запустите окно переписки: npm run bot:cli"
    )


def base_url(port: int) -> str:
    return f"http://127.0.0.1:{port}"


def post_action(port: int, action: dict[str, Any], timeout: float = 180.0) -> dict[str, Any]:
    request = urllib.request.Request(
        f"{base_url(port)}/action",
        data=json.dumps(action).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def get_state(port: int, timeout: float = 30.0) -> dict[str, Any]:
    with urllib.request.urlopen(f"{base_url(port)}/state", timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def stream_events(port: int, from_seq: int = 0) -> Iterator[dict[str, Any]]:
    """Поток событий сеанса (SSE). Обрывается вместе с сервером."""
    with urllib.request.urlopen(f"{base_url(port)}/events?from={from_seq}", timeout=None) as response:
        for raw in response:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data: "):
                continue
            try:
                yield json.loads(line[6:])
            except json.JSONDecodeError:
                continue
