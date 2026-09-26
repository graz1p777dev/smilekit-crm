# Instagram — настройка Meta App

Пошаговая инструкция для владельца бизнеса (не разработчика) — что нужно
сделать в Meta Developers один раз, чтобы клиенты CRM смогли подключать
свой Instagram кнопкой «Подключить», без ввода технических данных.

Технически используется современный флоу **Instagram API with Instagram
Login** (Business Login for Instagram) — он **не требует привязанной
Facebook Page**. Проверено по официальной документации Meta в августе 2026
(ссылки — в конце файла); старый Page-based флоу и scope без префикса
`instagram_` объявлены deprecated с 27.01.2025 — не использовать статьи,
которые их упоминают.

## 1. Создать Meta App

1. https://developers.facebook.com/apps → «Create App».
2. Тип приложения — **Business**.
3. Название — например «Smilekit CRM».
4. После создания — App Dashboard.

## 2. Добавить продукт Instagram

1. В App Dashboard → «Add Product» → найти **Instagram** → «Set up».
2. Выбрать вариант **Instagram API with Instagram Login** (НЕ старый
   вариант через Facebook Login/Page — он для другого флоу).

## 3. Настроить OAuth

1. Instagram → API setup with Instagram login → добавить **Redirect URI**:
   точный URL из переменной `META_REDIRECT_URI` (см. п. 13).
2. Скопировать **Instagram App ID** и **Instagram App Secret** — это
   значения `META_APP_ID` и `META_APP_SECRET`.

## 4. Permissions (какие запрашивать и зачем)

| Permission | Обязателен | Для чего | Где используется |
|---|---|---|---|
| `instagram_business_basic` | Да | Базовый доступ к профилю (id, username) — без него не работает ни один вызов Graph API | `fetchAccountInfo`, обязателен для refresh токена |
| `instagram_business_manage_messages` | Да | Чтение/отправка Direct-сообщений — это и есть вся суть интеграции | webhook `messages`, `sendInstagramMessage` |
| `instagram_business_manage_comments` | Да | Ответы на комментарии под постами и приватный ответ автору комментария в директ | webhook `comments`, `replyToInstagramComment`, `sendInstagramPrivateReply` |

Больше ничего не запрашивать — `instagram_business_content_publish` этому
продукту не нужен, лишние permissions только усложняют App Review.

> Разрешение на комментарии добавлено позже остальных. Аккаунт, подключённый
> до этого, его НЕ имеет: владельцу нужно ещё раз пройти
> Настройки → Instagram → «Подключить Instagram», иначе Graph API будет
> отвечать на ответы под постами ошибкой прав (INSTAGRAM_PERMISSION_DENIED).

## 5. Настроить Webhooks

1. App Dashboard → Webhooks → выбрать объект **Instagram**.
2. Callback URL — значение из п. 13 (`.../api/webhooks/instagram`).
3. Verify Token — придумать случайную строку, вписать её же в
   `META_WEBHOOK_VERIFY_TOKEN`.
4. Subscribe to fields: **messages** и **comments**.

Одной этой настройки недостаточно — после того как пользователь подключит
свой Instagram через кнопку в CRM, наш backend сам вызовет
`{ig-user-id}/subscribed_apps?subscribed_fields=messages,comments` с его токеном
(это уже сделано в коде, `subscribeWebhook` в `src/lib/instagram/oauth.ts`)
— без этого шага события по конкретному аккаунту не пойдут, даже если
Webhook в App Dashboard настроен верно.

## 6. Development Mode → Live

Пока приложение в Development Mode — им может пользоваться только владелец
App и добавленные им **Instagram Testers** (см. п. 14). Чтобы клиенты could
подключать реальные аккаунты, приложение нужно перевести в Live — это
делается через App Review (п. 11) для permissions с обязательным ревью, и
через ввод Business Verification (п. 12).

## 7. Permissions, требующие App Review

`instagram_business_basic` и `instagram_business_manage_messages` — **оба**
требуют App Review для использования вне Development Mode. Согласно
официальной документации, `instagram_business_manage_messages` не
одобряется отдельно — запрашивать нужно оба в одной заявке с чётким
описанием сценария использования (CRM для приёма/ответа на Direct).

## 8. Business Verification

Требуется для перевода приложения в Live-режим с чувствительными
permissions (messaging входит в их число). Настраивается в Meta Business
Suite → Business Settings → Security Center → Business Verification —
понадобятся официальные документы компании (регистрация юрлица/ИП).

## 9. Обязательные URL

В App Dashboard → Settings → Basic указать:
- **Privacy Policy URL**
- **Terms of Service URL**
- **User Data Deletion**: либо URL callback-эндпоинта, либо инструкция
  вручную (текст с контактом для запроса на удаление данных).

Без этих трёх пунктов App Review не запустится.

## 10. Тест до App Review — Instagram Testers

1. App Dashboard → Roles → Instagram Testers → добавить Instagram-аккаунт
   (свой тестовый профессиональный аккаунт).
2. В самом Instagram (приложение) этот тестовый аккаунт должен принять
   приглашение: Settings → Apps and websites → Tester invites.
3. Пока приложение в Development Mode, подключение и обмен сообщениями
   работают только для добавленных так тестеров — это и есть способ
   проверить весь флоу (п. 15) до Review.

## 11. App Review checklist

Что должен проделать Meta reviewer шаг за шагом (это описание пишется в
форму заявки на Review):

1. Открыть сайт CRM (production URL).
2. Войти в тестовый аккаунт (дать ревьюеру логин/пароль тестового
   пользователя CRM с ролью, у которой есть доступ к Настройкам).
3. Перейти в Настройки → Instagram.
4. Нажать «Подключить Instagram».
5. Авторизоваться через Instagram (тестовый Instagram-аккаунт из п. 10).
6. Отправить тестовому Instagram-аккаунту прямое сообщение с другого
   аккаунта.
7. Убедиться, что сообщение появилось в базе CRM (на данном этапе — только
   приём и хранение, без ответа ИИ, см. README реализации).
8. (Когда появится ручная/автоматическая отправка ответа) — отправить ответ
   из CRM и увидеть его в Instagram Direct.

Понадобится **тестовый Instagram Business/Creator аккаунт**, отдельный от
рабочего — для demo-видео и для самого ревью (Meta иногда запускает бота-
ревьюера, который реально пишет в тестовый аккаунт).

Meta обычно также просит **screen recording**: короткую запись экрана,
показывающую шаги 3–7 полностью — записать заранее и приложить к заявке,
это ускоряет одобрение.

## 12. Переменные окружения (Railway → smilekit-crm)

| Переменная | Откуда взять |
|---|---|
| `META_APP_ID` | App Dashboard → Settings → Basic → Instagram App ID (п. 3) |
| `META_APP_SECRET` | App Dashboard → Settings → Basic → Instagram App Secret (п. 3) |
| `META_REDIRECT_URI` | `https://<домен-crm>/api/instagram/callback` — тот же URL, что вписан в п. 3 |
| `META_WEBHOOK_VERIFY_TOKEN` | Придумать самим, вписать туда же, куда в п. 5 |
| `META_TOKEN_ENCRYPTION_KEY` | Сгенерировать: `openssl rand -base64 32` |

## 13. Точные URL для копирования

- **OAuth Redirect URI**: `https://<домен-crm>/api/instagram/callback`
- **Webhook Callback URL**: `https://<домен-crm>/api/webhooks/instagram`

(домен для продакшена сейчас — `smilekit-crm-production-73a6.up.railway.app`,
если он не сменится).

## 14. Локальная разработка

Meta не примет `localhost` как Redirect URI/Webhook URL — нужен публичный
HTTPS. Поднять туннель любым способом (ngrok, Cloudflare Tunnel — код от
конкретного провайдера не зависит) и временно указать его адрес и в
`META_REDIRECT_URI`/App Dashboard, и как Webhook Callback URL. Для чистой
разработки без реального Meta App можно тестировать `parseIncomingEvents`/
`verifySignature`/`sendInstagramMessage` через юнит-тесты
(`npm run test` — покрывают эти функции без сети).

## 15. Production checklist

- [ ] App переведён в Live, Business Verification пройдена
- [ ] `instagram_business_basic`, `instagram_business_manage_messages` и
      `instagram_business_manage_comments` одобрены через App Review
- [ ] Все 5 ENV заданы в Railway
- [ ] Миграции `20260831144639_instagram_messages.sql` и
      `20260926120000_instagram_bot.sql` применены к
      Supabase (файл лежит в `supabase/migrations/`, применяется вручную —
      через `supabase db push` или SQL Editor в дашборде Supabase)
- [ ] Webhook в App Dashboard указывает на прод-URL и подписан на `messages`
      и `comments`
- [ ] В Настройки → Instagram включены нужные переключатели автоответа
      (по умолчанию оба выключены — после подключения бот молчит)
- [ ] Redirect URI в App Dashboard совпадает с `META_REDIRECT_URI` дословно
- [ ] Privacy Policy / Terms / Data Deletion URL заполнены и реально
      открываются

## Источники (проверено, август 2026)

- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/webhooks
