// Заглушка src/lib/greenapi/client.ts для отладчика бота.
//
// Отладчик работает на боевой базе и боевых ключах, поэтому модуль отправки
// подменяется целиком на уровне загрузчика модулей (scripts/bot-cli-loader.mjs):
// ни одна функция здесь не ходит в сеть. Любая попытка отправки уходит в
// отладочный поток и печатается в терминале — в WhatsApp не уходит ничего.
//
// Экспортов здесь ровно столько же, сколько в настоящем client.ts (это
// проверяется тестом src/lib/greenapi/client-stub.test.ts): новая функция
// отправки не сможет проскочить мимо заглушки незамеченной.

/** Метка для проверки на старте сервера: настоящий клиент её не экспортирует. */
export const __BOT_CLI_STUB__ = true

function blocked(method, payload) {
  const report = globalThis.__botCliBlockedSend
  if (typeof report === 'function') report(method, payload)
  else console.error('[отладчик] отправка заблокирована:', method, JSON.stringify(payload))
  return { idMessage: `blocked:${method}:${Date.now()}` }
}

export function toGreenApiChatId(phone) {
  return `${String(phone).replace(/\D/g, '')}@c.us`
}

export function phoneFromGreenApiChatId(chatId) {
  return String(chatId).replace(/@c\.us$/, '')
}

export function toGreenApiGroupChatId(groupId) {
  return String(groupId).endsWith('@g.us') ? String(groupId) : `${groupId}@g.us`
}

export async function getGreenApiState() {
  blocked('getStateInstance', {})
  return 'authorized'
}

export async function setGreenApiWebhook(input) {
  blocked('setSettings', input)
}

export async function sendGreenApiMessage(chatId, message) {
  return blocked('sendMessage', { chatId, message })
}

export async function sendGreenApiFileByUrl(input) {
  return blocked('sendFileByUrl', input)
}

export async function sendGreenApiVoice(chatId, urlFile, fileName = 'voice.ogg') {
  return blocked('sendFileByUrl (голосовое)', { chatId, urlFile, fileName })
}

export async function sendGreenApiDeliveryGroup(groupId, text) {
  if (!groupId) return false
  blocked('sendMessage (группа)', { chatId: toGreenApiGroupChatId(groupId), message: text })
  return true
}

export async function sendGreenApiDeliveryGroupFile(groupId, input) {
  if (!groupId) return false
  blocked('sendFileByUrl (группа)', { chatId: toGreenApiGroupChatId(groupId), ...input })
  return true
}

export async function listGreenApiGroups() {
  blocked('getContacts', {})
  return []
}
