// Факты по одному клиенту: тип, сообщения до покупки, кто обслуживал.
// Серверный модуль без проверки роли — вызывать только из server actions,
// которые сами проверяют права.
import { createAdminClient } from '@/lib/supabase/admin'
import { classifyClient, type ClientFacts, type ClientType } from './client-types'

export interface ServedGroup {
  /** Кто был на смене в момент сообщений; пусто — на смене никого. */
  names: string[]
  messages: number
  firstAt: string
  lastAt: string
}

export interface ClientProfile {
  hasChat: boolean
  /** null — клиент ни разу не писал в WhatsApp. */
  type: ClientType | null
  totalMsgs: number
  msgsBeforeOrder: number | null
  msToOrder: number | null
  humanMessages: number
  served: ServedGroup[]
}

interface ClientFactsRpc {
  chatIds: string[]
  hasClientMessages: boolean | null
  firstDialogAt: string | null
  totalMsgs: number | null
  firstOrderAt: string | null
  msgsBeforeOrder: number | null
  humanAfterLastClient: boolean | null
  humanMessages: number
  served: ServedGroup[]
}

/** Общая часть для карточки клиента и сделки (без проверки роли). */
export async function loadClientProfile(phone: string): Promise<ClientProfile> {
  const { data, error } = await createAdminClient().rpc('analytics_client_facts', { p_phone: phone })
  if (error) throw new Error(`analytics_client_facts: ${error.message}`)
  const raw = data as ClientFactsRpc
  const hasChat = raw.chatIds.length > 0
  let type: ClientType | null = null
  let msToOrder: number | null = null
  if (hasChat && raw.hasClientMessages && raw.firstDialogAt) {
    const facts: ClientFacts = {
      firstDialogAt: Date.parse(raw.firstDialogAt),
      totalMsgs: raw.totalMsgs ?? 0,
      firstOrderAt: raw.firstOrderAt ? Date.parse(raw.firstOrderAt) : null,
      msgsBeforeOrder: raw.msgsBeforeOrder,
      humanAfterLastClient: raw.humanAfterLastClient === true,
    }
    type = classifyClient(facts)
    msToOrder = facts.firstOrderAt === null ? null : facts.firstOrderAt - facts.firstDialogAt
  }
  return {
    hasChat,
    type,
    totalMsgs: raw.totalMsgs ?? 0,
    msgsBeforeOrder: raw.msgsBeforeOrder,
    msToOrder,
    humanMessages: raw.humanMessages,
    served: raw.served,
  }
}
