import { ConfirmRequest } from '@/components/staff/StaffPortal'
import { findRequestByToken } from '@/lib/staff/service'

// Ссылка из WhatsApp: тот, кого заменяют, или владелец подтверждает
// «Моя смена» / «Работа вместе» одной кнопкой, без входа.
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Подтверждение смены — SmileKit', robots: { index: false } }

const STATUS_TEXT: Record<string, string> = {
  approved: 'Запрос уже подтверждён.',
  rejected: 'Запрос уже отклонён.',
  cancelled: 'Сотрудник отменил запрос.',
  expired: 'Запрос истёк — прошло больше 30 минут.',
}

export default async function ConfirmShiftPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const request = await findRequestByToken(token)
  const time = (iso: string) =>
    new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Bishkek', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-4 px-4 py-8">
      <header className="text-center">
        <p className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#5115a4' }}>SmileKit</p>
        <h1 className="mt-1 text-2xl font-semibold" style={{ fontFamily: 'var(--font-display)' }}>Подтверждение смены</h1>
      </header>
      {!request ? (
        <p className="rounded-xl bg-white p-5 text-center">Ссылка не найдена.</p>
      ) : (
        <section className="flex flex-col gap-4 rounded-2xl border bg-white p-5">
          <p className="text-lg">
            <b>{request.requesterName}</b>{' '}
            {request.kind === 'take'
              ? <>просит забрать смену у: <b>{request.holderNames.join(', ') || '—'}</b></>
              : <>просит работать вместе с: <b>{request.holderNames.join(', ') || '—'}</b></>}
          </p>
          <p className="text-sm text-gray-500">Запрос в {time(request.createdAt)}</p>
          {request.status === 'pending'
            ? <ConfirmRequest token={token} />
            : <p className="rounded-xl bg-gray-50 px-4 py-3 text-center">{STATUS_TEXT[request.status] ?? 'Запрос обработан.'}</p>}
        </section>
      )}
    </main>
  )
}
