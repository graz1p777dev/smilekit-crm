// Тесты автоответа в директе на поддельных ответах Graph API и Supabase —
// живого подключения Instagram нет, проверяем всю логику вокруг него.

import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => adminMock }))
vi.mock('@/lib/deals/auto-create', () => ({ upsertDealFromInbound: vi.fn(async () => ({ created: true, id: 'deal1' })) }))
vi.mock('@/lib/smilekit-bot-api', () => ({
  BOT_TIMEOUTS_MS: { lab: 1000 },
  smilekitBotFetch: vi.fn(),
}))
vi.mock('@/lib/bot-log', () => ({ logBotEvent: vi.fn() }))
vi.mock('@/lib/instagram/config', () => ({ getInstagramBotSettings: vi.fn() }))
vi.mock('@/lib/instagram/messaging', () => ({
  sendInstagramMessage: vi.fn(),
  fetchInstagramUserProfile: vi.fn(async () => null),
}))
vi.mock('@/lib/instagram/webhook', () => ({
  storeInboundMessage: vi.fn(),
  storeOutboundMessage: vi.fn(),
}))

import { upsertDealFromInbound } from '@/lib/deals/auto-create'
import { smilekitBotFetch } from '@/lib/smilekit-bot-api'
import { getInstagramBotSettings } from '@/lib/instagram/config'
import { sendInstagramMessage, fetchInstagramUserProfile } from '@/lib/instagram/messaging'
import { storeInboundMessage, storeOutboundMessage, type ParsedIncomingMessage } from '@/lib/instagram/webhook'
import {
  handleInstagramInboundMessage,
  isWithinMessagingWindow,
  instagramExternalKey,
  MESSAGING_WINDOW_MS,
} from '@/lib/instagram/dm-bot'
import { INSTAGRAM_GREETING } from '@/lib/instagram/texts'

// --- поддельный Supabase -----------------------------------------------
// Цепочка .from().select().eq().order().limit() / .maybeSingle() разрешается
// в заранее заданный ответ; какой именно — определяет таблица и список полей
// (по двум разным select-ам к instagram_messages их и различаем).
interface DbFixtures {
  optOut: unknown
  chatControl: unknown
  operatorMessages: { created_at: string }[]
  history: { mid: string; text: string; direction: string }[]
}
let fixtures: DbFixtures

function builderFor(table: string) {
  let columns = ''
  const builder = {
    select(cols: string) {
      columns = cols
      return builder
    },
    update: () => builder,
    eq: () => builder,
    order: () => builder,
    limit: () => Promise.resolve({ data: table === 'instagram_messages' && columns === 'created_at' ? fixtures.operatorMessages : fixtures.history }),
    maybeSingle: () => Promise.resolve({ data: table === 'chat_control' ? fixtures.chatControl : fixtures.optOut }),
    // update(...).eq(...) ждут как промис
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
  }
  return builder
}

const adminMock = { from: (table: string) => builderFor(table) }

// -----------------------------------------------------------------------
const message: ParsedIncomingMessage = {
  mid: 'm1',
  senderIgsid: 'u1',
  recipientIgsid: 'acct1',
  text: 'Здравствуйте, сколько стоит?',
  timestampMs: Date.now(),
  raw: {} as ParsedIncomingMessage['raw'],
}

beforeEach(() => {
  vi.clearAllMocks()
  // Непустая история по умолчанию: первое сообщение (history=[]) теперь
  // отвечает фиксированным приветствием, а не ИИ — см. отдельный тест ниже.
  // Остальные тесты этого файла проверяют именно путь через ИИ (generateReply).
  fixtures = {
    optOut: null,
    chatControl: null,
    operatorMessages: [],
    history: [{ mid: 'm0', text: 'Привет', direction: 'in' }],
  }
  vi.mocked(storeInboundMessage).mockResolvedValue(true)
  vi.mocked(fetchInstagramUserProfile).mockResolvedValue(null)
  vi.mocked(getInstagramBotSettings).mockResolvedValue({ dmEnabled: true, commentsEnabled: false })
  vi.mocked(smilekitBotFetch).mockResolvedValue({ ok: true, data: { reply: 'Одна коробка — 1490 сом' } })
  vi.mocked(sendInstagramMessage).mockResolvedValue({ recipientId: 'u1', messageId: 'out1' })
})

describe('окно 24 часа', () => {
  it('только что пришедшее сообщение — окно открыто', () => {
    const now = Date.now()
    expect(isWithinMessagingWindow(now, now)).toBe(true)
  })
  it('ровно сутки и больше — окно закрыто', () => {
    const now = Date.now()
    expect(isWithinMessagingWindow(now - MESSAGING_WINDOW_MS, now)).toBe(false)
    expect(isWithinMessagingWindow(now - MESSAGING_WINDOW_MS - 60_000, now)).toBe(false)
  })
})

describe('handleInstagramInboundMessage', () => {
  it('первое сообщение в чате — фиксированное приветствие, ИИ не зовём', async () => {
    fixtures.history = []
    await handleInstagramInboundMessage(message)
    expect(smilekitBotFetch).not.toHaveBeenCalled()
    expect(sendInstagramMessage).toHaveBeenCalledWith({ recipientId: 'u1', text: INSTAGRAM_GREETING })
  })

  it('отвечает клиенту и сохраняет исходящее', async () => {
    await handleInstagramInboundMessage(message)
    expect(sendInstagramMessage).toHaveBeenCalledWith({ recipientId: 'u1', text: 'Одна коробка — 1490 сом' })
    expect(storeOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ mid: 'out1', recipientIgsid: 'u1', status: 'sent' })
    )
  })

  it('заводит сделку source=instagram с ником из Graph API', async () => {
    vi.mocked(fetchInstagramUserProfile).mockResolvedValue({ name: 'Айжан', username: 'aizhan' })
    await handleInstagramInboundMessage(message)
    expect(upsertDealFromInbound).toHaveBeenCalledWith({
      externalKey: instagramExternalKey('u1'),
      source: 'instagram',
      customerName: 'Айжан',
      customerUsername: 'aizhan',
    })
  })

  it('дубль вебхука: второй ответ не уходит и сделка не заводится заново', async () => {
    vi.mocked(storeInboundMessage).mockResolvedValue(false)
    await handleInstagramInboundMessage(message)
    expect(upsertDealFromInbound).not.toHaveBeenCalled()
    expect(smilekitBotFetch).not.toHaveBeenCalled()
    expect(sendInstagramMessage).not.toHaveBeenCalled()
  })

  it('переключатель директа выключен — лид заводим, но ничего не пишем', async () => {
    vi.mocked(getInstagramBotSettings).mockResolvedValue({ dmEnabled: false, commentsEnabled: true })
    await handleInstagramInboundMessage(message)
    expect(upsertDealFromInbound).toHaveBeenCalled()
    expect(sendInstagramMessage).not.toHaveBeenCalled()
  })

  it('клиент в стоп-списке — бот молчит', async () => {
    fixtures.optOut = { igsid: 'u1' }
    await handleInstagramInboundMessage(message)
    expect(sendInstagramMessage).not.toHaveBeenCalled()
  })

  it('чат ведёт менеджер (писал живой человек) — бот молчит', async () => {
    fixtures.operatorMessages = [{ created_at: new Date().toISOString() }]
    await handleInstagramInboundMessage(message)
    expect(sendInstagramMessage).not.toHaveBeenCalled()
  })

  it('менеджер вернул чат боту тумблером после своего сообщения — бот снова отвечает', async () => {
    fixtures.operatorMessages = [{ created_at: new Date(Date.now() - 60_000).toISOString() }]
    fixtures.chatControl = { bot_enabled: true, updated_at: new Date().toISOString() }
    await handleInstagramInboundMessage(message)
    expect(sendInstagramMessage).toHaveBeenCalled()
  })

  it('окно 24 часа закрыто — не отправляем, но помечаем в журнале', async () => {
    await handleInstagramInboundMessage({ ...message, timestampMs: Date.now() - MESSAGING_WINDOW_MS - 1000 })
    expect(sendInstagramMessage).not.toHaveBeenCalled()
    expect(storeOutboundMessage).toHaveBeenCalledWith(expect.objectContaining({ status: 'window_closed' }))
  })

  it('Instagram не подключён — не падаем, помечаем неудачу', async () => {
    vi.mocked(sendInstagramMessage).mockRejectedValue(new Error('Instagram не подключён'))
    await expect(handleInstagramInboundMessage(message)).resolves.toBeUndefined()
    expect(storeOutboundMessage).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }))
  })

  it('ИИ недоступен даже со второй попытки — короткий честный текст вместо тишины', async () => {
    vi.mocked(smilekitBotFetch).mockResolvedValue({ ok: false, status: 502, error: 'down' })
    await handleInstagramInboundMessage(message)
    expect(smilekitBotFetch).toHaveBeenCalledTimes(2)
    expect(sendInstagramMessage).toHaveBeenCalledWith({
      recipientId: 'u1',
      text: expect.stringContaining('не расслышала'),
    })
  })

  it('ИИ выдумал скидку, о которой не спрашивали — уходит утверждённый текст о товаре', async () => {
    vi.mocked(smilekitBotFetch).mockResolvedValue({ ok: true, data: { reply: 'Сделаю скидку 20%!' } })
    await handleInstagramInboundMessage({ ...message, text: 'Здравствуйте' })
    expect(sendInstagramMessage).toHaveBeenCalledWith({
      recipientId: 'u1',
      text: expect.stringContaining('14 отбеливающих полосок'),
    })
  })

  it('ответ из нескольких частей уходит отдельными сообщениями', async () => {
    vi.mocked(smilekitBotFetch).mockResolvedValue({ ok: true, data: { reply: 'Первое<NEXT_MESSAGE>Второе' } })
    await handleInstagramInboundMessage(message)
    expect(sendInstagramMessage).toHaveBeenCalledTimes(2)
  })
})
