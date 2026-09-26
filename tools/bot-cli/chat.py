"""Окно 1 отладчика: переписка с ботом.

Пишете текст — бот отвечает ровно так же, как отвечал бы клиенту в WhatsApp,
только в служебном чате и без единой реальной отправки. Подробный разбор
(какое правило сработало, почему выбран шаблон, что ушло в ИИ) идёт во второе
окно: npm run bot:debug
"""

from __future__ import annotations

import re
import sys
import threading
from typing import Any

from rich.console import Console
from rich.panel import Panel
from rich.prompt import Confirm, Prompt
from rich.table import Table
from rich.text import Text

import session

console = Console()

HELP = [
    ("<текст>", "сообщение от клиента"),
    ("/reset", "начать с нуля — новый служебный чат, бот видит нового клиента"),
    ("/time +2h", "перемотать время назад (+30m, +2h, +1d) и прогнать проверку дожимов"),
    ("/state", "метки, этап сделки, кто ведёт чат, сколько сообщений"),
    ("/manager <текст>", "сообщение «от менеджера» — бот должен замолчать"),
    ("/photo [url]", "картинка-чек (по умолчанию — тестовая картинка бота)"),
    ("/voice <текст>", "голосовое; текст — это его расшифровка"),
    ("/help", "эта справка"),
    ("/quit", "выход, с предложением удалить следы служебного чата"),
]

SHIFT = re.compile(r"^\+?(\d+)\s*(m|h|d|м|ч|д)$", re.IGNORECASE)
UNIT_MS = {"m": 60_000, "м": 60_000, "h": 3_600_000, "ч": 3_600_000, "d": 86_400_000, "д": 86_400_000}


def parse_shift(value: str) -> int | None:
    match = SHIFT.match(value.strip())
    if not match:
        return None
    return int(match.group(1)) * UNIT_MS[match.group(2).lower()]


def show_help() -> None:
    table = Table(title="Команды", title_style="bold magenta", header_style="bold")
    table.add_column("Команда", style="cyan", no_wrap=True)
    table.add_column("Что делает")
    for command, description in HELP:
        table.add_row(command, description)
    console.print(table)


def show_state(state: dict[str, Any]) -> None:
    table = Table(title=f"Состояние чата {state['chatId']}", title_style="bold magenta")
    table.add_column("Что", style="cyan")
    table.add_column("Значение")
    table.add_row("Сообщений", str(state["messages"]))
    table.add_row("Чат ведёт", "менеджер" if state["managerControls"] else "бот")
    deal = state.get("deal")
    table.add_row("Сделка", f"{deal['stage']} / {deal['status']}" if deal else "нет (отладка сделок не заводит)")
    control = state.get("control")
    table.add_row("chat_control", f"bot_enabled={control['bot_enabled']}" if control else "не задан")
    markers = state.get("markers") or []
    table.add_row("Метки", "\n".join(m["id"] for m in markers) if markers else "нет")
    console.print(table)


def watch(port: int, seen: set[int]) -> None:
    """Ответы бота приходят потоком — так второе окно переписки видит то же самое."""
    try:
        for event in session.stream_events(port):
            if event["kind"] != "chat":
                continue
            for message in event["payload"]["messages"]:
                if message["id"] in seen:
                    continue
                seen.add(message["id"])
                if message["sender"] == "client":
                    continue
                style = "green" if message["sender"] == "bot" else "yellow"
                title = "Бот" if message["sender"] == "bot" else "Менеджер"
                console.print(Panel(Text(message["text"]), title=title, border_style=style, title_align="left"))
    except Exception:  # сервер закрылся — окно тоже закрывается
        return


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else int(session.wait_for_session()["port"])
    state = session.get_state(port)["state"]
    seen: set[int] = set()
    threading.Thread(target=watch, args=(port, seen), daemon=True).start()

    console.print(
        Panel(
            Text.from_markup(
                f"Служебный чат: [bold]{state['chatId']}[/bold]\n"
                "В WhatsApp не уходит ничего: модуль отправки подменён заглушкой, всё идёт в режиме dryRun.\n"
                "Разбор решений бота — во втором окне: [bold]npm run bot:debug[/bold]\n"
                "[dim]/help — список команд[/dim]"
            ),
            title="Отладчик бота SmileKit",
            border_style="magenta",
        )
    )

    while True:
        try:
            line = Prompt.ask("[bold cyan]клиент[/bold cyan]").strip()
        except (EOFError, KeyboardInterrupt):
            line = "/quit"
        if not line:
            continue

        command, _, argument = line.partition(" ")
        argument = argument.strip()
        action: dict[str, Any]

        if command == "/help":
            show_help()
            continue
        if command == "/quit":
            purge = Confirm.ask("Удалить следы служебного чата из базы?", default=True)
            session.post_action(port, {"type": "quit", "purge": purge})
            console.print("[dim]Сеанс закрыт.[/dim]")
            return
        if command == "/state":
            action = {"type": "state"}
        elif command == "/reset":
            action = {"type": "reset"}
        elif command == "/time":
            shift_ms = parse_shift(argument)
            if shift_ms is None:
                console.print("[red]Не понял срок. Примеры: /time +30m, /time +2h, /time +1d[/red]")
                continue
            action = {"type": "time", "shiftMs": shift_ms}
        elif command == "/manager":
            if not argument:
                console.print("[red]Нужен текст: /manager Здравствуйте, я менеджер[/red]")
                continue
            action = {"type": "manager", "text": argument}
        elif command == "/photo":
            action = {"type": "photo", "text": "", "url": argument or None}
        elif command == "/voice":
            if not argument:
                console.print("[red]Нужна расшифровка: /voice Здравствуйте, сколько стоит[/red]")
                continue
            action = {"type": "voice", "text": argument}
        elif command.startswith("/"):
            console.print(f"[red]Неизвестная команда {command}. /help — список.[/red]")
            continue
        else:
            action = {"type": "message", "text": line}

        if action["type"] in {"message", "voice", "photo"}:
            console.print(Panel(Text(action.get("text") or "[картинка]"), title="Клиент", border_style="cyan", title_align="left"))

        with console.status("[dim]бот думает…[/dim]"):
            try:
                result = session.post_action(port, action)
            except Exception as error:  # noqa: BLE001 — показать владельцу как есть
                console.print(f"[red]Ошибка сеанса: {error}[/red]")
                continue

        if not result.get("ok"):
            console.print(f"[red]{result.get('error')}[/red]")
            continue
        if command in {"/state", "/reset", "/time"}:
            show_state(result["state"])


if __name__ == "__main__":
    main()
