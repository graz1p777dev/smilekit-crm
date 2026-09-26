// Загрузчик модулей для отладчика: подменяет src/lib/greenapi/client.ts
// заглушкой, чтобы из отладочного сеанса физически нельзя было отправить
// сообщение в WhatsApp — ни из bot-reply.ts, ни из планировщика дожимов, ни
// из любого нового места, которое появится позже.
//
// Подключается из scripts/bot-cli-server.mts ДО первого импорта кода бота.
// Если подмена почему-то не сработала, ядро это замечает по метке
// __BOT_CLI_STUB__ и отказывается стартовать.
import { registerHooks } from 'node:module'

const STUB_URL = new URL('./bot-cli-greenapi-stub.mjs', import.meta.url).href
const CLIENT_MODULE = /\/src\/lib\/greenapi\/client\.[cm]?tsx?$/

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context)
    if (CLIENT_MODULE.test(new URL(resolved.url).pathname)) {
      return { ...resolved, url: STUB_URL, shortCircuit: true }
    }
    return resolved
  },
})
