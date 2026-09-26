#!/usr/bin/env bash
# Готовит локальное окружение Python для отладчика бота: своё .venv внутри
# репозитория (в git не попадает) и единственная зависимость — rich.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
venv="$here/.venv"

if [ ! -x "$venv/bin/python" ]; then
  echo "Отладчик бота: создаю окружение Python в tools/bot-cli/.venv"
  python3 -m venv "$venv"
  "$venv/bin/python" -m pip install --quiet --upgrade pip
fi

if ! "$venv/bin/python" -c "import rich" >/dev/null 2>&1; then
  "$venv/bin/python" -m pip install --quiet -r "$here/requirements.txt"
fi
