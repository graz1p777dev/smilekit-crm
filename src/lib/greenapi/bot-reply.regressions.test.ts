// Регресс-тесты на «живые баги» WhatsApp-бота — каждый кейс взят из реального
// диалога с клиентом (скриншот или проверка в Лаборатории), а не выдуман.
// Цель — не дать уже найденной и исправленной ошибке вернуться незаметно при
// будущих правках regex-роутинга в bot-reply.ts.
import { describe, expect, it } from 'vitest'
import {
  AI_IMPROVISED_CHECKLIST,
  AI_IMPROVISED_DISCOUNT,
  FUTURE_ORDER_QUESTION,
  isBulkBroadcast,
  NOT_A_LOCATION_REPLY,
  PAY_ON_DELIVERY_REQUEST,
  PICKUP_QUESTION,
  SAFETY_COMPOSITION_HARM_DOUBT,
  SAFETY_COMPOSITION_SAFE_DOUBT,
  SCAM_DOUBT,
  UNSUPPORTED_COUNTRY,
} from './bot-reply'

describe('isBulkBroadcast — рассылка мимо CRM не должна выглядеть как передача менеджеру', () => {
  it('живой баг 09.09: один и тот же текст ушёл ~400 клиентам за час, помеченным sender=operator — бот замолчал у всех разом', () => {
    // Тот же текст уже ушёл двум другим чатам — с этим уже три подряд.
    expect(isBulkBroadcast(2)).toBe(true)
  })
  it('первая пара отправок ещё не считается рассылкой — не хватает сигнала', () => {
    expect(isBulkBroadcast(0)).toBe(false)
    expect(isBulkBroadcast(1)).toBe(false)
  })
})

describe('UNSUPPORTED_COUNTRY — бот больше не врёт про доставку в дальнее зарубежье', () => {
  it('ловит вопрос про Германию (реальный живой баг сессии)', () => {
    expect(UNSUPPORTED_COUNTRY.test('А если я из Германии, привезёте?')).toBe(true)
  })
  it('не ловит реальные города КР по случайному совпадению', () => {
    expect(UNSUPPORTED_COUNTRY.test('Я из Бишкека')).toBe(false)
    expect(UNSUPPORTED_COUNTRY.test('Живу в Оше')).toBe(false)
  })
})

describe('FUTURE_ORDER_QUESTION — вопрос про будущее не улетает в чек-лист сразу', () => {
  it('ловит «можем завтра оформить заказ?»', () => {
    expect(FUTURE_ORDER_QUESTION.test('Мы можем завтра оформить заказ?')).toBe(true)
  })
  it('не мешает прямому «оформите» без слова про будущее', () => {
    expect(FUTURE_ORDER_QUESTION.test('Оформите мне заказ')).toBe(false)
  })
})

describe('AI_IMPROVISED_CHECKLIST — ловит самовольный чек-лист ИИ даже в несколько строк', () => {
  it('ловит многострочный список без слова «чек» в отдельном пункте (реальный текст ИИ)', () => {
    const text =
      'Конечно! Для оформления доставки в Бишкеке напишите, пожалуйста, одним сообщением:\n\n' +
      'Адрес доставки\nНомер телефона\n\nИ мы сразу передадим заказ в доставку 😊'
    expect(AI_IMPROVISED_CHECKLIST.test(text)).toBe(true)
  })
  it('не ловит обычное многострочное приветствие', () => {
    const text = 'Здравствуйте! 😊\n\nSmileKit помогает заметно отбелить зубы уже после первого применения.'
    expect(AI_IMPROVISED_CHECKLIST.test(text)).toBe(false)
  })
})

describe('SAFETY_COMPOSITION — «вредно?» уходит голосом, «безопасно?» текстом', () => {
  it('«не вредно ли для эмали?» — вопрос через вред/опасно', () => {
    expect(SAFETY_COMPOSITION_HARM_DOUBT.test('А не вредно ли для эмали?')).toBe(true)
    expect(SAFETY_COMPOSITION_SAFE_DOUBT.test('А не вредно ли для эмали?')).toBe(false)
  })
  it('«состав безопасный?» — вопрос через безопасно, НЕ через вред', () => {
    expect(SAFETY_COMPOSITION_SAFE_DOUBT.test('А состав безопасный?')).toBe(true)
    expect(SAFETY_COMPOSITION_HARM_DOUBT.test('А состав безопасный?')).toBe(false)
  })
})

describe('PAY_ON_DELIVERY_REQUEST — ловит и инфинитив «оплатить», не только «оплачу»', () => {
  it('ловит реальную фразу клиента из истории чатов', () => {
    expect(PAY_ON_DELIVERY_REQUEST.test('Я хочу оплатить после того как приеду')).toBe(true)
  })
  it('ловит «оплата при получении или сразу» (вопрос, не только прямая просьба)', () => {
    expect(PAY_ON_DELIVERY_REQUEST.test('Аа оплата при получение или сразу')).toBe(true)
  })
})

describe('NOT_A_LOCATION_REPLY — общие отговорки не принимаются за адрес/город', () => {
  it('«Хорошо подумаю» — реальный случай ложного подтверждения заказа', () => {
    expect(NOT_A_LOCATION_REPLY.test('хорошо подумаю')).toBe(true)
  })
  it('«Хорошо, спасибо» — комбинация двух слов блок-листа', () => {
    expect(NOT_A_LOCATION_REPLY.test('хорошо, спасибо')).toBe(true)
  })
  it('не ловит настоящий адрес', () => {
    expect(NOT_A_LOCATION_REPLY.test('бишкек, ул. ленина 5, +996700123456')).toBe(false)
  })
})

describe('PICKUP_QUESTION — новый ответ про самовывоз', () => {
  it('ловит «самовывоз есть?»', () => {
    expect(PICKUP_QUESTION.test('Здравствуйте, а самовывоз есть?')).toBe(true)
  })
  it('не путает с обычным вопросом про заказ', () => {
    expect(PICKUP_QUESTION.test('Оформите мне заказ')).toBe(false)
  })
})

describe('SCAM_DOUBT — не путает с ORDER_INTENT', () => {
  it('«вы не мошенники?» ловится, а не уходит в оформление', () => {
    expect(SCAM_DOUBT.test('А вы не мошенники?')).toBe(true)
  })
})

describe('AI_IMPROVISED_DISCOUNT — ловит самовольную скидку ИИ (реальный живой баг)', () => {
  it('ловит реальный текст ИИ со скидкой 13%/1290 сом', () => {
    const text = 'Вы писали насчёт полосок — я могу оформить вам пачку со скидкой 13%, цена будет 1290 сом. Подскажите, в каком вы городе?'
    expect(AI_IMPROVISED_DISCOUNT.test(text)).toBe(true)
  })
  it('не ловит обычный ответ про цену без скидки', () => {
    expect(AI_IMPROVISED_DISCOUNT.test('Цена — 1490 сом, полный курс — 14 полосок.')).toBe(false)
  })
})
