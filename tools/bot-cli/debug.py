"""Окно 2 отладчика: всё, что бот делает.

Подключается к тому же сеансу, что и окно переписки (порт берётся из
.session.json), и в реальном времени печатает каждое решение: какое правило
сработало и почему, какой шаблон выбран, что ушло в ИИ и что он вернул, какие
метки поставлены в базе и что было бы отправлено в WhatsApp.
"""

from __future__ import annotations

import json
import time
from datetime import datetime
from typing import Any

from rich.console import Console, Group
from rich.panel import Panel
from rich.table import Table
from rich.text import Text

import session

console = Console()

# Шаг сценария → как его назвать владельцу и каким цветом показать.
STEPS: dict[str, tuple[str, str]] = {
    "inbound": ("Пришло сообщение", "cyan"),
    "voice.transcribed": ("Голосовое расшифровано", "cyan"),
    "context": ("Контекст", "blue"),
    "context.reply": ("Контекст ответа", "blue"),
    "context.cta": ("Согласие на предложение оформить", "blue"),
    "rule.matched": ("Сработало правило", "bold magenta"),
    "branch": ("Ветка сценария", "magenta"),
    "reply.chosen": ("Выбран ответ", "bold green"),
    "outbound": ("Ушло бы в WhatsApp", "green"),
    "blocked": ("Отправка заблокирована", "bold red"),
    "ai.request": ("Запрос к ИИ", "yellow"),
    "ai.response": ("Ответ ИИ", "yellow"),
    "ai.retry": ("Повтор запроса к ИИ", "yellow"),
    "ai.failed": ("ИИ не ответил", "red"),
    "ai.overridden": ("Ответ ИИ заменён шаблоном", "bold yellow"),
    "discount.step": ("Лестница скидок", "bold magenta"),
    "receipt.checked": ("Проверка чека", "magenta"),
    "receipt.side-effects-skipped": ("Последствия заказа пропущены", "dim"),
    "db.claim": ("Метка-защёлка в базе", "blue"),
    "db.marker": ("Метка в базе", "blue"),
    "deal.stage": ("Этап сделки", "blue"),
    "gate.can-send": ("Можно ли писать в чат", "dim"),
    "handoff": ("Передача менеджеру", "bold red"),
    "handoff.card": ("Карточка менеджеру", "red"),
    "handoff.remind": ("Напоминание менеджеру", "red"),
    "manager.message": ("Написал менеджер", "yellow"),
    "stop": ("Бот молчит", "bold red"),
    "time.shift": ("Перемотка времени", "bold blue"),
    "followup.candidate": ("Кандидат на дожим", "blue"),
    "followup.skip": ("Дожим пропущен", "dim"),
    "followup.disabled": ("Дожим в проде выключен — показ «что было бы»", "bold yellow"),
    "followup.send": ("Дожим ушёл бы", "bold green"),
}

# Эти шаги — «фон»: полезны, но в глаза лезть не должны.
QUIET = {"gate.can-send", "db.claim", "context", "context.reply", "context.cta", "followup.skip"}


def clock(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000).strftime("%H:%M:%S")


def render_details(details: dict[str, Any]) -> Group:
    parts: list[Any] = []
    why = details.pop("why", None)
    if why:
        parts.append(Text(str(why), style="italic"))
    if not details:
        return Group(*parts)
    table = Table(show_header=False, box=None, padding=(0, 1))
    table.add_column(style="dim", no_wrap=True)
    table.add_column(overflow="fold")
    for key, value in details.items():
        if value is None or value == [] or value == {}:
            continue
        if isinstance(value, (dict, list)):
            rendered = json.dumps(value, ensure_ascii=False, indent=2)
        else:
            rendered = str(value)
        table.add_row(key, rendered)
    parts.append(table)
    return Group(*parts)


def show(event: dict[str, Any]) -> None:
    kind = event["kind"]
    payload = event["payload"]

    if kind == "chat":
        return  # переписка — дело первого окна

    if kind == "session":
        console.print(
            Panel(
                render_details(dict(payload)),
                title=f"[{clock(event['ts'])}] Сеанс",
                border_style="magenta",
                title_align="left",
            )
        )
        return

    if kind == "blocked":
        title, style = STEPS["blocked"]
        console.print(
            Panel(
                render_details({
                    "метод Green API": payload["method"],
                    "данные": payload["payload"],
                    "why": "заглушка отладчика: в WhatsApp это НЕ ушло",
                }),
                title=f"[{clock(event['ts'])}] {title}",
                border_style=style,
                title_align="left",
            )
        )
        return

    step = payload["step"]
    title, style = STEPS.get(step, (step, "white"))
    details = dict(payload.get("details") or {})
    if step in QUIET:
        why = details.get("why") or ""
        console.print(Text(f"  [{clock(event['ts'])}] {title}: {why}", style="dim"))
        return
    console.print(
        Panel(
            render_details(details),
            title=f"[{clock(event['ts'])}] {title}",
            border_style=style,
            title_align="left",
        )
    )


def main() -> None:
    info = session.wait_for_session()
    port = int(info["port"])
    console.print(
        Panel(
            Text.from_markup(
                f"Сеанс: [bold]127.0.0.1:{port}[/bold]\nСлужебный чат: [bold]{info['chatId']}[/bold]\n"
                "Всё, что делает бот, появляется здесь. Переписка — в первом окне."
            ),
            title="Отладка бота SmileKit",
            border_style="magenta",
        )
    )
    last_seq = 0
    while True:
        try:
            for event in session.stream_events(port, last_seq):
                last_seq = event["seq"]
                show(event)
        except KeyboardInterrupt:
            return
        except Exception:  # noqa: BLE001
            if not session.SESSION_FILE.exists():
                console.print("[dim]Сеанс закрыт.[/dim]")
                return
            time.sleep(1)


if __name__ == "__main__":
    main()
