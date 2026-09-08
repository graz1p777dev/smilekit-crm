import { NextResponse, type NextRequest } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { checkRateLimit, getClientIp } from '@/lib/rate-limit'

// Обрабатывает OAuth/Magic Link/Recovery коды от Supabase.
// Суть: обменять code на сессию SERVER-SIDE (ставит cookie),
// затем редиректить куда нужно. Только так cookie видна middleware и Server Actions.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/dashboard'

  const ip = getClientIp(request)
  const limit = checkRateLimit(`auth-callback:ip:${ip}`, { windowMs: 60_000, max: 10 })
  if (!limit.allowed) {
    return new NextResponse('Too Many Requests', { status: 429, headers: { 'Retry-After': String(limit.retryAfterSeconds) } })
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/auth/login?error=missing_code`)
  }

  const cookieStore = await cookies()
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        },
      },
    }
  )

  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    console.error('[auth/callback] exchangeCodeForSession:', error.message)
    return NextResponse.redirect(`${origin}/auth/forgot-password?error=invalid_code`)
  }

  return NextResponse.redirect(`${origin}${next}`)
}
