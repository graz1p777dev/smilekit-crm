// Сообщения менеджеров, подписанные именами сотрудников CRM.
//
// PostgREST отдаёт не больше 1000 строк за запрос. Зарплата и «лидов ответил»
// раньше читали сообщения менеджеров одним запросом и получали 1000 случайных
// из десятков тысяч — цифры были неполными. Здесь: только нужные авторы
// (сотрудники CRM, а не «Smilekit» с телефона) и постранично.

import { createAdminClient } from '@/lib/supabase/admin'

export interface OperatorMessageRow {
  chat_id: string
  author_name: string | null
  created_at: string
}

export async function operatorMessagesByAuthors(
  authorNames: string[],
  range?: { from?: string; to?: string }
): Promise<OperatorMessageRow[]> {
  const names = [...new Set(authorNames.map((n) => n.trim()).filter(Boolean))]
  if (!names.length) return []
  const admin = createAdminClient()
  const rows: OperatorMessageRow[] = []
  for (let from = 0; ; from += 1000) {
    let query = admin
      .from('chat_messages')
      .select('chat_id, author_name, created_at')
      .eq('sender', 'operator')
      .in('author_name', names)
    if (range?.from) query = query.gte('created_at', range.from)
    if (range?.to) query = query.lt('created_at', range.to)
    const { data, error } = await query.order('id').range(from, from + 999)
    if (error) throw new Error(`chat_messages: ${error.message}`)
    rows.push(...((data ?? []) as OperatorMessageRow[]))
    if (!data || data.length < 1000) return rows
  }
}
