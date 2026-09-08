import { randomBytes } from 'crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { buildAuthorizeUrl } from '@/lib/instagram/oauth'

// Шаг 1 OAuth: только владелец может подключать/переподключать интеграции
// (тот же уровень доступа, что и у /dashboard/settings), генерируем
// одноразовый криптослучайный `state` на CSRF и кладём в httpOnly cookie —
// callback сверяет их совпадение. TTL 10 минут — дольше OAuth-хендшейк с
// Meta не должен занимать.

const STATE_COOKIE = 'ig_oauth_state'
const STATE_TTL_SECONDS = 600

async function isOwner(): Promise<boolean> {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return false
  const { data } = await supabase.from('employees').select('role').eq('user_id', session.user.id).single()
  return data?.role === 'owner'
}

export async function GET() {
  if (!(await isOwner())) {
    return NextResponse.json({ error: 'Недостаточно прав' }, { status: 403 })
  }

  const state = randomBytes(32).toString('hex')
  const response = NextResponse.redirect(buildAuthorizeUrl(state))
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: STATE_TTL_SECONDS,
    path: '/api/instagram',
  })
  return response
}
