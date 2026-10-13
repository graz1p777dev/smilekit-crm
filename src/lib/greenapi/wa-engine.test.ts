import { afterEach, describe, expect, it } from 'vitest'
import { isServiceError, isWaEngineEnabled, isWaEnginePhone, waHistoryText, waMediaUrl } from './wa-engine'

describe('новая логика WhatsApp', () => {
  const saved = process.env.GREENAPI_WA_ENGINE_PHONES
  afterEach(() => {
    if (saved === undefined) delete process.env.GREENAPI_WA_ENGINE_PHONES
    else process.env.GREENAPI_WA_ENGINE_PHONES = saved
  })

  it('без переменной не включается ни для кого', () => {
    delete process.env.GREENAPI_WA_ENGINE_PHONES
    expect(isWaEngineEnabled()).toBe(false)
    expect(isWaEnginePhone('996500896899')).toBe(false)
  })

  it('включается только для перечисленных номеров, в любом написании', () => {
    process.env.GREENAPI_WA_ENGINE_PHONES = '+996 500 896 899'
    expect(isWaEnginePhone('996500896899')).toBe(true)
    expect(isWaEnginePhone('996500896899@c.us')).toBe(true)
    expect(isWaEnginePhone('996500896898')).toBe(false)
    expect(isWaEnginePhone('99650089689')).toBe(false)
  })

  it('«*» включает новую логику для всех клиентов', () => {
    process.env.GREENAPI_WA_ENGINE_PHONES = '*'
    expect(isWaEngineEnabled()).toBe(true)
    expect(isWaEnginePhone('996700123456')).toBe(true)
  })

  it('ошибка 5xx сервиса отправки — «возможно доставлено», остальные — «не отправлено»', () => {
    expect(isServiceError(new Error('green-api sendMessage: HTTP 500 "Connection to queue not established"'))).toBe(true)
    expect(isServiceError(new Error('green-api sendMessage: HTTP 466 quota'))).toBe(false)
    expect(isServiceError(new Error('fetch failed'))).toBe(false)
  })

  it('файлы берутся из сервиса бота, а в историю пишется пометка вместо файла', () => {
    const base = 'https://bot.example'
    expect(waMediaUrl(base, { kind: 'photo', body: 'results/before_after.jpg' })).toBe(`${base}/media/results/before_after.jpg`)
    expect(waMediaUrl(base, { kind: 'qr', body: 'qrcode.jpeg' })).toBe(`${base}/media/results/qrcode.jpeg`)
    expect(waMediaUrl(base, { kind: 'voice', body: 'voice/first_use_effect.ogg' })).toBe(`${base}/media/voice/first_use_effect.ogg`)
    expect(waHistoryText({ kind: 'qr', body: 'qrcode.jpeg' })).toBe('[QR оплаты]')
    expect(waHistoryText({ kind: 'text', body: 'Здравствуйте' })).toBe('Здравствуйте')
  })
})
