// Тест клиента Control Center: без CONTROL_CENTER_URL/CONTROL_CENTER_TOKEN
// модуль обязан быть no-op (fetch ни разу не вызывается), а с заданными
// переменными — слать правильную форму payload на нужный путь с Bearer-токеном.
//
// Модуль читает env один раз при импорте, поэтому каждый сценарий
// перезагружает его через vi.resetModules() + dynamic import после
// vi.stubEnv().

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('control-center client', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('никогда не вызывает fetch, если CONTROL_CENTER_URL/CONTROL_CENTER_TOKEN не заданы', async () => {
    vi.stubEnv('CONTROL_CENTER_URL', '')
    vi.stubEnv('CONTROL_CENTER_TOKEN', '')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { sendHeartbeat, recordUsage, recordEvent } = await import('./control-center')

    sendHeartbeat({ status: 'ok' })
    recordUsage({ provider: 'deepseek', model: 'deepseek-v4-flash', inputTokens: 10, outputTokens: 5 })
    recordEvent({ type: 'deal', title: 'Deal created', payload: { dealId: '1' } })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('шлёт module-load предупреждение один раз, когда env не задан', async () => {
    vi.stubEnv('CONTROL_CENTER_URL', '')
    vi.stubEnv('CONTROL_CENTER_TOKEN', '')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await import('./control-center')

    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('sendHeartbeat отправляет правильный payload и заголовки, когда env задан', async () => {
    vi.stubEnv('CONTROL_CENTER_URL', 'https://cc.example.com')
    vi.stubEnv('CONTROL_CENTER_TOKEN', 'test-token')
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const { sendHeartbeat } = await import('./control-center')

    sendHeartbeat({ status: 'ok', gitSha: 'abc123', environment: 'production' })
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://cc.example.com/api/v1/connector/heartbeat')
    expect(options.method).toBe('POST')
    expect((options.headers as Record<string, string>).authorization).toBe('Bearer test-token')
    expect(JSON.parse(options.body as string)).toEqual({
      status: 'ok',
      gitSha: 'abc123',
      environment: 'production',
    })
  })

  it('recordUsage/recordEvent батчат и флашат как {events:[...]} на свои пути', async () => {
    vi.useFakeTimers()
    vi.stubEnv('CONTROL_CENTER_URL', 'https://cc.example.com')
    vi.stubEnv('CONTROL_CENTER_TOKEN', 'test-token')
    const fetchMock = vi.fn().mockResolvedValue({ ok: true })
    vi.stubGlobal('fetch', fetchMock)

    const { recordUsage, recordEvent } = await import('./control-center')

    recordUsage({ provider: 'deepseek', model: 'deepseek-v4-flash', inputTokens: 10, outputTokens: 5 })
    recordEvent({ type: 'order', title: 'Order ingested', payload: { orderId: '42' } })

    await vi.advanceTimersByTimeAsync(60_000)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const calls = fetchMock.mock.calls as [string, RequestInit][]
    const usageCall = calls.find(([url]) => url.endsWith('/api/v1/connector/usage'))
    const eventsCall = calls.find(([url]) => url.endsWith('/api/v1/connector/events'))
    expect(usageCall).toBeDefined()
    expect(eventsCall).toBeDefined()
    expect(JSON.parse(usageCall![1].body as string)).toEqual({
      events: [{ provider: 'deepseek', model: 'deepseek-v4-flash', inputTokens: 10, outputTokens: 5 }],
    })
    expect(JSON.parse(eventsCall![1].body as string)).toEqual({
      events: [{ type: 'order', title: 'Order ingested', payload: { orderId: '42' } }],
    })
  })
})

describe('control-center prompt sync', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  function enable() {
    vi.stubEnv('CONTROL_CENTER_URL', 'https://cc.example.com')
    vi.stubEnv('CONTROL_CENTER_TOKEN', 'test-token')
  }

  function promptResponse(status: number, body?: unknown) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }
  }

  it('200 кэширует промпт, а следующий запрос шлёт If-None-Match с versionId', async () => {
    enable()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(promptResponse(200, { ok: true, versionId: 'v3', compiled: 'REMOTE' }))
      .mockResolvedValueOnce(promptResponse(304))
    vi.stubGlobal('fetch', fetchMock)

    const { fetchPromptIfChanged, getRemotePrompt, currentPrompt } = await import('./control-center')

    await fetchPromptIfChanged()
    expect(getRemotePrompt()).toEqual({ compiled: 'REMOTE', versionId: 'v3' })
    expect(currentPrompt('local')).toBe('REMOTE')

    const [firstUrl, firstOptions] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(firstUrl).toBe('https://cc.example.com/api/v1/connector/prompt')
    expect((firstOptions.headers as Record<string, string>).authorization).toBe('Bearer test-token')
    expect((firstOptions.headers as Record<string, string>)['if-none-match']).toBeUndefined()

    await fetchPromptIfChanged()
    const [, secondOptions] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect((secondOptions.headers as Record<string, string>)['if-none-match']).toBe('"v3"')
  })

  it('304 сохраняет кэш', async () => {
    enable()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(promptResponse(200, { ok: true, versionId: 'v3', compiled: 'REMOTE' }))
      .mockResolvedValueOnce(promptResponse(304))
    vi.stubGlobal('fetch', fetchMock)

    const { fetchPromptIfChanged, getRemotePrompt } = await import('./control-center')

    await fetchPromptIfChanged()
    await fetchPromptIfChanged()
    expect(getRemotePrompt()).toEqual({ compiled: 'REMOTE', versionId: 'v3' })
  })

  it('404 → getRemotePrompt() null, currentPrompt возвращает локальный fallback', async () => {
    enable()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(promptResponse(404, { error: 'not found' })))

    const { fetchPromptIfChanged, getRemotePrompt, currentPrompt } = await import('./control-center')

    await fetchPromptIfChanged()
    expect(getRemotePrompt()).toBeNull()
    expect(currentPrompt('local')).toBe('local')
  })

  it('сетевая ошибка сохраняет последнее удачное значение и не бросает', async () => {
    enable()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(promptResponse(200, { ok: true, versionId: 'v3', compiled: 'REMOTE' }))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
    vi.stubGlobal('fetch', fetchMock)

    const { fetchPromptIfChanged, getRemotePrompt, currentPrompt } = await import('./control-center')

    await fetchPromptIfChanged()
    await expect(fetchPromptIfChanged()).resolves.toBeUndefined()
    expect(getRemotePrompt()).toEqual({ compiled: 'REMOTE', versionId: 'v3' })
    expect(currentPrompt('local')).toBe('REMOTE')
  })

  it('без CONTROL_CENTER_URL/CONTROL_CENTER_TOKEN fetch не вызывается, промпт локальный', async () => {
    vi.stubEnv('CONTROL_CENTER_URL', '')
    vi.stubEnv('CONTROL_CENTER_TOKEN', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { fetchPromptIfChanged, getRemotePrompt, currentPrompt } = await import('./control-center')

    await fetchPromptIfChanged()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getRemotePrompt()).toBeNull()
    expect(currentPrompt('local')).toBe('local')
  })
})
