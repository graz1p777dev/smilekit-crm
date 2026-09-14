import { getBotSettings } from '@/actions/smilekit-bot-settings'
import { getWhatsappSettings } from '@/actions/whatsapp-settings'
import { getInstagramStatus } from '@/actions/instagram-settings'
import { SmilekitBotSettingsClient } from '@/components/bot/SmilekitBotSettingsClient'
import { SmilekitBotApiError } from '@/components/bot/SmilekitBotApiError'
import WhatsappSettingsClient from '@/components/whatsapp/WhatsappSettingsClient'
import InstagramSettingsClient from '@/components/instagram/InstagramSettingsClient'
import SettingsTabs from '@/components/settings/SettingsTabs'
import SystemSettings from '@/components/settings/SystemSettings'

// Все настройки собраны здесь вкладками: система CRM, бот, WhatsApp,
// Instagram. Отдельных пунктов меню у них больше нет.
//
// Бот и каналы — внешние сервисы, их настройки читаются на сервере, чтобы
// SMILEKIT_BOT_INTERNAL_TOKEN и ключи каналов не попали в браузер.
export const dynamic = 'force-dynamic'

export const metadata = { title: 'Настройки — Smilekit' }

const NoAccess = () => <div className="p-8 text-sm text-gray-400">Нет доступа</div>

export default async function SettingsPage() {
  // Каждая вкладка тянет свой внешний сервис. Падение одной не должно
  // ронять всю страницу настроек: Promise.all отменяет остальные и отдаёт
  // ошибку рендера целиком (ровно так дашборд упал на отсутствующей
  // таблице instagram_messages).
  const safe = async <T,>(load: () => Promise<T>): Promise<T | null> => {
    try {
      return await load()
    } catch {
      return null
    }
  }
  const [bot, whatsapp, instagram] = await Promise.all([
    safe(getBotSettings),
    safe(getWhatsappSettings),
    safe(getInstagramStatus),
  ])

  return (
    <SettingsTabs
      system={<SystemSettings />}
      bot={
        bot === null
          ? <SmilekitBotApiError error="Сервис бота не ответил" />
          : bot.ok
            ? <SmilekitBotSettingsClient settings={bot.data} />
            : <SmilekitBotApiError error={bot.error} />
      }
      whatsapp={whatsapp ? <WhatsappSettingsClient initialConfig={whatsapp} /> : <NoAccess />}
      instagram={instagram ? <InstagramSettingsClient initialIntegration={instagram} /> : <NoAccess />}
    />
  )
}
