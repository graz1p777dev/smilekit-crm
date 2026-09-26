// Отладчик бота работает на боевых ключах Green API, поэтому модуль отправки
// в нём подменяется заглушкой (scripts/bot-cli-greenapi-stub.mjs). Эти тесты
// стерегут два свойства заглушки:
//   1. она закрывает ВСЕ экспорты настоящего клиента — новая функция отправки
//      не сможет проскочить мимо неё незамеченной;
//   2. ни одна её функция не ходит в сеть, каждая попытка отправки
//      рапортуется в терминал.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as realClient from './client'
import * as stub from '../../../scripts/bot-cli-greenapi-stub.mjs'

interface GlobalWithReport {
  __botCliBlockedSend?: (method: string, payload: unknown) => void
}

const reports: { method: string; payload: unknown }[] = []

beforeEach(() => {
  reports.length = 0
  ;(globalThis as GlobalWithReport).__botCliBlockedSend = (method, payload) => {
    reports.push({ method, payload })
  }
})

describe('заглушка Green API покрывает весь настоящий клиент', () => {
  it('у заглушки есть каждый экспорт client.ts', () => {
    const missing = Object.keys(realClient).filter((name) => !(name in stub))
    expect(missing).toEqual([])
  })

  it('заглушка помечена — ядро отладчика без этой метки не стартует', () => {
    expect((stub as unknown as { __BOT_CLI_STUB__: boolean }).__BOT_CLI_STUB__).toBe(true)
    expect('__BOT_CLI_STUB__' in realClient).toBe(false)
  })
})

describe('заглушка не отправляет ничего в WhatsApp', () => {
  it('ни одна функция отправки не ходит в сеть, каждая попытка видна в отладке', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await stub.sendGreenApiMessage('996700000000@c.us', 'Здравствуйте!')
    await stub.sendGreenApiFileByUrl({ chatId: '996700000000@c.us', urlFile: 'https://x/qr.jpeg', fileName: 'qr.jpeg' })
    await stub.sendGreenApiVoice('996700000000@c.us', 'https://x/voice.ogg', 'voice.ogg')
    await stub.sendGreenApiDeliveryGroup('120363000000000000', 'Новый заказ')
    await stub.sendGreenApiDeliveryGroupFile('120363000000000000', { urlFile: 'https://x/r.jpg', fileName: 'r.jpg' })
    await stub.setGreenApiWebhook({ webhookUrl: 'https://x', webhookUrlToken: 'секрет' })
    await stub.getGreenApiState()
    await stub.listGreenApiGroups()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(reports).toHaveLength(8)
    expect(reports[0]).toEqual({
      method: 'sendMessage',
      payload: { chatId: '996700000000@c.us', message: 'Здравствуйте!' },
    })
    fetchSpy.mockRestore()
  })

  it('без выбранной группы доставки заглушка, как и настоящий клиент, молчит', async () => {
    expect(await stub.sendGreenApiDeliveryGroup(null, 'текст')).toBe(false)
    expect(await stub.sendGreenApiDeliveryGroupFile(null, { urlFile: 'https://x/r.jpg', fileName: 'r.jpg' })).toBe(false)
    expect(reports).toHaveLength(0)
  })

  it('чистые функции адресации считают так же, как настоящий клиент', () => {
    expect(stub.toGreenApiChatId('+996 700 12-34-56')).toBe(realClient.toGreenApiChatId('+996 700 12-34-56'))
    expect(stub.phoneFromGreenApiChatId('996700123456@c.us')).toBe(
      realClient.phoneFromGreenApiChatId('996700123456@c.us')
    )
    expect(stub.toGreenApiGroupChatId('12345')).toBe(realClient.toGreenApiGroupChatId('12345'))
  })
})
