// Ядро консольного отладчика WhatsApp-бота SmileKit.
//
// Что это: локальный сервер на 127.0.0.1 со случайным портом. Он гоняет ровно
// ту же логику бота, что отвечает живым клиентам (src/lib/greenapi/*), но
// в служебном чате и в режиме dryRun, и отдаёт наружу поток трассировки.
// Поверх него работают два окна на Python + rich:
//   окно 1 — переписка (tools/bot-cli/chat.py, его поднимает этот же процесс);
//   окно 2 — отладка (tools/bot-cli/debug.py, подключается к тому же сеансу).
//
// Безопасность (главное требование):
//   1. Чат только служебный, id вида lab-cli-<метка времени> — реальный номер
//      сюда попасть не может: id генерируется здесь и телефоном не является.
//   2. Модуль отправки подменён заглушкой на уровне загрузчика
//      (scripts/bot-cli-loader.mjs) — проверяется на старте, без заглушки
//      сервер не поднимается вообще.
//   3. Всё гоняется с dryRun: сделки, заказы, остатки, группы доставки и
//      внешние вебхуки не трогаются.
//   4. Фоновые планировщики не поднимаются: проверка дожимов вызывается
//      напрямую по команде /time.
//   5. /reset и /time меняют строки ТОЛЬКО служебного чата, /quit предлагает
//      удалить его следы.

import { spawn } from 'node:child_process'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { processInboundGreenApiMessage } from '@/lib/greenapi/bot-reply'
import { runFollowupOnce } from '@/lib/greenapi/followup-scheduler'
import { setTraceSink, type TraceEvent } from '@/lib/greenapi/trace'
import { createAdminClient } from '@/lib/supabase/admin'
import * as greenApiClient from '@/lib/greenapi/client'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SESSION_DIR = path.join(REPO_ROOT, 'tools', 'bot-cli')
const SESSION_FILE = path.join(SESSION_DIR, '.session.json')
const CHAT_UI = path.join(SESSION_DIR, 'chat.py')
const VENV_PYTHON = path.join(SESSION_DIR, '.venv', 'bin', 'python')

// ── Проверка №1: без заглушки отправки сервер не стартует ────────────────────
const stubMarker = (greenApiClient as unknown as { __BOT_CLI_STUB__?: boolean }).__BOT_CLI_STUB__
if (stubMarker !== true) {
  console.error(
    'Отладчик не запущен: модуль отправки Green API не подменён заглушкой.\n' +
      'Запускать только через scripts/bot-cli-server.mts (npm run bot:cli), иначе сообщения ушли бы реальным клиентам.'
  )
  process.exit(1)
}

// ── Состояние сеанса ─────────────────────────────────────────────────────────
const LAB_CHAT_PREFIX = 'lab-cli-'
const newChatId = (): string => `${LAB_CHAT_PREFIX}${Date.now()}`

let chatId = newChatId()
let messageCounter = 0

interface StreamEvent {
  seq: number
  kind: 'trace' | 'chat' | 'blocked' | 'session'
  ts: number
  payload: Record<string, unknown>
}

let quitRequested = false
const subscribers = new Set<ServerResponse>()
const history: StreamEvent[] = []
let seq = 0

function emit(kind: StreamEvent['kind'], payload: Record<string, unknown>): void {
  const event: StreamEvent = { seq: ++seq, kind, ts: Date.now(), payload }
  history.push(event)
  if (history.length > 2000) history.shift()
  const line = `data: ${JSON.stringify(event)}\n\n`
  for (const response of subscribers) response.write(line)
}

setTraceSink((event: TraceEvent) => {
  emit('trace', { step: event.step, chatId: event.chatId, details: event.details })
})

// Заглушка отправки рапортует сюда — видно каждую попытку уйти в Green API.
;(globalThis as unknown as { __botCliBlockedSend?: (m: string, p: unknown) => void }).__botCliBlockedSend = (
  method,
  payload
) => {
  emit('blocked', { method, payload })
}

// ── Работа с базой: только служебный чат ─────────────────────────────────────
const supabase = createAdminClient()

/** Защита от опечатки в коде: любой запрос на удаление проверяет id чата. */
function assertLabChat(id: string): string {
  if (!id.startsWith(LAB_CHAT_PREFIX)) {
    throw new Error(`отладчик: попытка тронуть не служебный чат (${id}) — остановлено`)
  }
  return id
}

interface ChatRow {
  id: number
  amo_message_id: string
  sender: string
  direction: string
  text: string
  created_at: string
}

async function readChat(): Promise<ChatRow[]> {
  const { data } = await supabase
    .from('chat_messages')
    .select('id, amo_message_id, sender, direction, text, created_at')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
  return (data ?? []) as ChatRow[]
}

/** Служебные метки — не сообщения, в переписке их показывать не нужно. */
const isMarker = (row: ChatRow): boolean => row.amo_message_id.startsWith('ga:claim:')

async function publishChat(): Promise<void> {
  const rows = await readChat()
  emit('chat', {
    chatId,
    messages: rows.filter((row) => !isMarker(row)).map((row) => ({
      id: row.id,
      sender: row.sender,
      text: row.text,
      createdAt: row.created_at,
    })),
  })
}

async function purgeChat(id: string): Promise<void> {
  assertLabChat(id)
  await supabase.from('chat_messages').delete().eq('chat_id', id)
  await supabase.from('chat_control').delete().eq('chat_id', id)
  // Сделок и заказов у служебного чата быть не должно (всё идёт с dryRun), но
  // удаляем на случай, если новая ветка кода когда-нибудь их заведёт.
  await supabase.from('deals').delete().eq('external_key', `greenapi:${id}`)
  await supabase.from('orders').delete().like('external_key', `greenapi:${id}%`)
}

/**
 * Подмести следы прошлых сеансов: если отладчик закрыли не через /quit
 * (Ctrl+C, упавший терминал), его строки остаются в базе. Все чаты
 * lab-cli-* — служебные по построению, реального клиента среди них быть не
 * может, поэтому новый сеанс начинается с чистого листа.
 */
async function purgeAllLabChats(): Promise<number> {
  const { data } = await supabase
    .from('chat_messages')
    .select('chat_id')
    .like('chat_id', `${LAB_CHAT_PREFIX}%`)
  const ids = [...new Set((data ?? []).map((row) => (row as { chat_id: string }).chat_id))]
  for (const id of ids) await purgeChat(id)
  return ids.length
}

async function sessionState(): Promise<Record<string, unknown>> {
  const rows = await readChat()
  const { data: control } = await supabase
    .from('chat_control')
    .select('bot_enabled, updated_at')
    .eq('chat_id', chatId)
    .maybeSingle()
  const { data: deal } = await supabase
    .from('deals')
    .select('stage, status')
    .eq('external_key', `greenapi:${chatId}`)
    .maybeSingle()
  const lastOperator = [...rows].reverse().find((row) => row.sender === 'operator')
  return {
    chatId,
    messages: rows.filter((row) => !isMarker(row)).length,
    markers: rows.filter(isMarker).map((row) => ({ id: row.amo_message_id, text: row.text, createdAt: row.created_at })),
    control: control ?? null,
    deal: deal ?? null,
    managerControls: Boolean(lastOperator),
    lastOperatorAt: lastOperator?.created_at ?? null,
  }
}

// ── Действия ─────────────────────────────────────────────────────────────────
const botOptions = { dryRun: true, skipIntegrationCheck: true } as const

async function sendClientMessage(text: string, extra: { messageType?: string; mediaUrl?: string } = {}): Promise<void> {
  messageCounter += 1
  await processInboundGreenApiMessage(
    {
      providerMessageId: `labcli-${chatId}-${messageCounter}`,
      chatId,
      authorName: 'Отладка (владелец)',
      text,
      ...extra,
    },
    botOptions
  )
}

async function addManagerMessage(text: string): Promise<void> {
  messageCounter += 1
  await supabase.from('chat_messages').insert({
    amo_message_id: `ga:labcli-manager-${chatId}-${messageCounter}`,
    chat_id: chatId,
    direction: 'out',
    sender: 'operator',
    author_name: 'Менеджер (отладка)',
    text,
  })
  emit('trace', {
    step: 'manager.message',
    chatId,
    details: { text, why: 'сообщение «от менеджера» — дальше бот в этом чате должен замолчать' },
  })
}

/** Перемотать время назад: записи чата «стареют» на shiftMs. */
async function shiftTime(shiftMs: number): Promise<number> {
  assertLabChat(chatId)
  const rows = await readChat()
  for (const row of rows) {
    const shifted = new Date(new Date(row.created_at).getTime() - shiftMs).toISOString()
    await supabase.from('chat_messages').update({ created_at: shifted }).eq('id', row.id)
  }
  emit('trace', {
    step: 'time.shift',
    chatId,
    details: { rows: rows.length, shiftMs, why: 'записи чата состарены — теперь проверяем, что сделал бы планировщик дожимов' },
  })
  await runFollowupOnce({ onlyChatId: chatId, dryRun: true, includeDisabledStages: true })
  return rows.length
}

interface ActionRequest {
  type: string
  text?: string
  shiftMs?: number
  url?: string
  purge?: boolean
}

async function runAction(action: ActionRequest): Promise<Record<string, unknown>> {
  switch (action.type) {
    case 'message':
      await sendClientMessage(action.text ?? '')
      break
    case 'manager':
      await addManagerMessage(action.text ?? '')
      break
    case 'photo': {
      const url = action.url || `${process.env.SMILEKIT_BOT_API_URL?.replace(/\/$/, '')}/media/results/qrcode.jpeg`
      await sendClientMessage(action.text ?? '', { messageType: 'image', mediaUrl: url })
      break
    }
    case 'voice':
      // Расшифровку подставляем текстом: без mediaUrl transcribeGreenApiVoice
      // возвращает исходный текст, дальше бот работает ровно как с голосовым.
      await sendClientMessage(action.text ?? '', { messageType: 'audio' })
      break
    case 'reset': {
      const previous = chatId
      await purgeChat(previous)
      chatId = newChatId()
      messageCounter = 0
      emit('session', { chatId, previous, why: 'новый служебный чат — бот видит совершенно нового клиента' })
      break
    }
    case 'time':
      await shiftTime(action.shiftMs ?? 0)
      break
    case 'state':
      break
    case 'quit':
      if (action.purge) await purgeChat(chatId)
      emit('session', { chatId, quit: true, purged: Boolean(action.purge) })
      // Гасим сервер не здесь, а после того, как ответ уйдёт окну переписки —
      // иначе оно получает обрыв соединения вместо подтверждения.
      quitRequested = true
      break
    default:
      throw new Error(`неизвестное действие: ${action.type}`)
  }
  await publishChat()
  return await sessionState()
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/events') {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    // Догоняем опоздавшее окно: новый подписчик получает всё, что уже было.
    const from = Number(url.searchParams.get('from') ?? '0')
    for (const event of history) {
      if (event.seq > from) response.write(`data: ${JSON.stringify(event)}\n\n`)
    }
    subscribers.add(response)
    request.on('close', () => subscribers.delete(response))
    return
  }
  if (url.pathname === '/action' && request.method === 'POST') {
    void readBody(request)
      .then((body) => runAction(JSON.parse(body || '{}') as ActionRequest))
      .then((state) => {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: true, state }))
        if (quitRequested) setTimeout(() => shutdown(0), 200)
      })
      .catch((error: unknown) => {
        response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
      })
    return
  }
  if (url.pathname === '/state') {
    void sessionState().then((state) => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: true, state }))
    })
    return
  }
  response.writeHead(404)
  response.end()
})

let shuttingDown = false
function shutdown(code: number): void {
  if (shuttingDown) return
  shuttingDown = true
  setTraceSink(null)
  rmSync(SESSION_FILE, { force: true })
  for (const response of subscribers) response.end()
  server.close(() => process.exit(code))
  setTimeout(() => process.exit(code), 1_000).unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// Слушаем ТОЛЬКО петлевой интерфейс — сеанс никому снаружи не виден.
server.listen(0, '127.0.0.1', async () => {
  const swept = await purgeAllLabChats().catch(() => 0)
  if (swept) console.log(`Подметены следы прошлых сеансов: чатов — ${swept}`)
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  mkdirSync(SESSION_DIR, { recursive: true })
  writeFileSync(SESSION_FILE, JSON.stringify({ port, chatId, pid: process.pid }, null, 2))
  console.log(`Отладчик бота: сеанс поднят на http://127.0.0.1:${port} (служебный чат ${chatId})`)
  console.log('Окно отладки: npm run bot:debug')
  emit('session', { chatId, port, why: 'сеанс запущен; отправка в Green API заглушена, всё идёт в режиме dryRun' })

  if (process.env.BOT_CLI_NO_UI === '1') return
  const ui = spawn(VENV_PYTHON, [CHAT_UI, String(port)], { stdio: 'inherit' })
  ui.on('exit', () => shutdown(0))
  ui.on('error', (error) => {
    console.error('Не удалось запустить окно переписки:', error.message)
    console.error(`Запустите вручную: ${VENV_PYTHON} ${CHAT_UI} ${port}`)
  })
})
