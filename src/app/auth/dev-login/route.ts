// Вход без ввода пароля — ТОЛЬКО для локальной разработки.
//
// Включается переменной AUTH_BYPASS=1, которая живёт исключительно в
// .env.local (он в .gitignore и на прод не попадает). Без этой переменной
// роут отдаёт 404, поэтому на задеплоенном сайте обычный вход по логину и
// паролю остаётся единственным способом попасть в систему.
//
// Реализовано именно как настоящий вход под заведённым владельцем, а не как
// подставной пользователь: сессия настоящая, значит RLS, роли и права
// работают ровно так же, как в бою, и локальная разработка не расходится
// с продакшеном.
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { checkRateLimit, getClientIp } from '@/lib/rate-limit'

export async function GET(request: Request) {
  // Защита на случай, если AUTH_BYPASS случайно включат в проде — сам роут
  // и так отдаёт 404 без него, это лишь дополнительный рубеж.
  const ip = getClientIp(request)
  const limit = checkRateLimit(`dev-login:ip:${ip}`, { windowMs: 60_000, max: 10 })
  if (!limit.allowed) {
    return new NextResponse('Too Many Requests', { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } })
  }

  if (process.env.AUTH_BYPASS !== '1') {
    return new NextResponse('Not found', { status: 404 })
  }

  const email = process.env.DEV_LOGIN_EMAIL
  const password = process.env.DEV_LOGIN_PASSWORD
  if (!email || !password) {
    return new NextResponse(
      'AUTH_BYPASS=1, но не заданы DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD в .env.local',
      { status: 500 },
    )
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    return new NextResponse(
      `Не удалось войти как ${email}: ${error.message}. ` +
        'Проверьте, что пользователь заведён: npm run seed:owner',
      { status: 500 },
    )
  }

  return NextResponse.redirect(new URL('/dashboard', request.url))
}
