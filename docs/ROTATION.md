# Ротация общих секретов без простоя

Все входящие общие секреты CRM проверяются через `matchesRotatableSecret()`
(`src/lib/webhook-auth.ts`): запрос принимается, если значение совпадает с
`<NAME>` **или** с `<NAME>_NEXT` (когда тот задан и непуст). Благодаря этому
секрет можно сменить без окна, в котором отправитель и получатель не совпадают.
Ожидаемое время одной ротации — меньше 10 минут.

## Какие секреты ротируются и кто с какой стороны

| Переменная (получатель — CRM) | Кто отправляет | Где меняется у отправителя |
|---|---|---|
| `INTERNAL_NOTIFY_TOKEN` | Telegram-бот Smilekit (`bot/smilekit_bot`, заголовок `x-internal-token`) и деплой-скрипт на VPS | env бота: `CRM_INTERNAL_TOKEN` (`smilekit_bot/config.py`); у деплой-скрипта — его собственный env |
| `AMOCRM_WEBHOOK_SECRET` | amoCRM (`?secret=` в URL вебхука) | amoCRM → Настройки → Интеграции → Webhooks: URL вебхука |
| `WAZZUP_WEBHOOK_SECRET` | Wazzup24 (`?secret=` в `webhooksUri`) | `PATCH https://api.wazzup24.com/v3/webhooks` с новым `webhooksUri` |
| `GREENAPI_WEBHOOK_TOKEN` | Green API (`Authorization: Bearer`) | `setGreenApiWebhook` / настройки инстанса Green API (`webhookUrlToken`) |
| `META_WEBHOOK_VERIFY_TOKEN` | Meta (GET-хендшейк Instagram Webhooks, `hub.verify_token`) | Meta App Dashboard → Webhooks → Verify Token |

Принимающие маршруты: `src/app/api/internal/**` (`INTERNAL_NOTIFY_TOKEN`),
`src/app/api/amocrm/webhook`, `src/app/api/whatsapp/webhook`,
`src/app/api/greenapi/webhook`, `src/app/api/webhooks/instagram` (GET).

**Не ротируется этой процедурой:** `SMILEKIT_BOT_INTERNAL_TOKEN` — здесь CRM
выступает *отправителем* (`src/lib/smilekit-bot-api.ts`), получатель — бот.
Его ротация делается на стороне бота по его правилам; в CRM просто меняется
значение переменной.

## Процедура (для одной переменной `<NAME>`)

1. **Получатель (CRM, Railway):** добавить `<NAME>_NEXT=<новое значение>`.
   Дождаться редеплоя. С этого момента CRM принимает и старое, и новое значение.
2. **Отправитель / провайдер:** переключить на новое значение (см. таблицу).
   Проверить, что запросы проходят (логи CRM: не должно быть `401`/`403` от этого
   источника).
3. **Получатель (CRM, Railway):** записать новое значение в `<NAME>`, удалить
   `<NAME>_NEXT`. Дождаться редеплоя. Старое значение больше не принимается.

Между шагами 1 и 3 оба значения валидны, поэтому порядок редеплоев
отправителя и получателя не важен и ни один запрос не отклоняется.

## Проверки

- Пустой или отсутствующий `<NAME>_NEXT` игнорируется — обычный режим работы.
- `<NAME>_NEXT` не должен «жить» дольше ротации: после шага 3 его быть не должно.
- Никогда не коммитить значения секретов — только имена переменных.
