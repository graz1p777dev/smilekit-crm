'use client'
import { useState } from 'react'
import { Label } from '@/components/ui/label'
import {
  Eye, EyeOff, Lock, Mail, PlugZap,
  Package, MessageSquareText, Target, Wallet,
} from 'lucide-react'
import { signIn } from '@/actions/auth'

// Разделы, которые в системе действительно есть: каталог магазина, инбокс
// с ИИ-ботом, декомпозиция плана и расчёт зарплаты.
const features = [
  { icon: Package, label: 'Товары', desc: 'Каталог и остатки' },
  { icon: MessageSquareText, label: 'Диалоги', desc: 'Клиенты и ИИ-бот' },
  { icon: Target, label: 'KPI и план', desc: 'Декомпозиция цели' },
  { icon: Wallet, label: 'Зарплата', desc: 'Авторасчёт по KPI' },
]

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    const result = await signIn(email, password)
    if (!result.success) {
      setError(result.error)
      setLoading(false)
    } else if (result.mustChangePassword) {
      // Полный reload гарантирует, что Set-Cookie из Server Action попадут в document.cookie
      // до того, как Next.js начнёт рендер следующей страницы (устраняет race condition).
      window.location.href = '/auth/change-password'
    } else {
      // ?next=/instrukciya.html — вернуть туда, откуда пришли (например, из
      // помощника на странице инструкции). Только пути своего сайта.
      const next = new URLSearchParams(window.location.search).get('next') ?? ''
      window.location.href = next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard'
    }
  }

  const inputClass =
    'w-full h-11 rounded-xl border text-sm transition-all outline-none ' +
    'border-[#ece5e5] bg-[#faf8f7] text-[#1b1517] placeholder:text-[#a19698] ' +
    'focus:border-[#5115a4] focus:bg-white focus:ring-[3px] focus:ring-[#5115a4]/14'

  return (
    <div className="min-h-screen flex relative overflow-hidden" style={{ backgroundColor: '#faf8f7' }}>
      {/* Тёплое свечение в углах — тот же приём, что в hero: чуть подкрашенный
          свет, а не цветная плита. */}
      <div
        className="absolute inset-0 pointer-events-none"
        aria-hidden
        style={{
          background:
            'radial-gradient(circle at 12% 8%, rgba(81, 21, 164,0.10), transparent 34%),' +
            'radial-gradient(circle at 88% 92%, rgba(138, 104, 173,0.08), transparent 36%)',
        }}
      />

      {/* Левая часть — бренд */}
      <div className="hidden lg:flex w-[54%] flex-col justify-between p-12 relative z-10">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 brand-mark flex-shrink-0" aria-hidden />
          <span className="brand-wordmark text-base" style={{ color: '#1b1517' }}>smilekit crm</span>
        </div>

        <div>
          <div
            className="flex items-center gap-2 uppercase"
            style={{ color: '#5115a4', fontSize: 12, fontWeight: 800, letterSpacing: '0.13em' }}
          >
            <PlugZap size={15} /> Единая система управления
          </div>

          <h2
            style={{
              margin: '14px 0 14px',
              maxWidth: 620,
              color: '#1b1517',
              fontSize: 'clamp(34px, 4.2vw, 56px)',
              lineHeight: 0.98,
              letterSpacing: '-0.05em',
              fontWeight: 700,
            }}
          >
            Магазин и команда
            <br />
            <span className="gradient-text">в одном месте</span>
          </h2>

          <p style={{ margin: 0, maxWidth: 440, color: '#574d4f', fontSize: 15, lineHeight: 1.65 }}>
            Товары, диалоги с клиентами, план по выручке и расчёт зарплаты — считаются в одной
            системе, без переноса данных руками.
          </p>

          <div className="grid grid-cols-2 gap-3 mt-9" style={{ maxWidth: 560 }}>
            {features.map(({ icon: Icon, label, desc }) => (
              <div
                key={label}
                className="flex items-center gap-3 p-4"
                style={{
                  background: '#ffffff',
                  border: '1px solid #ece5e5',
                  borderRadius: 20,
                  boxShadow: '0 1px 2px rgba(28,20,22,0.04)',
                }}
              >
                <div
                  className="flex items-center justify-center flex-shrink-0"
                  style={{
                    width: 44, height: 44, borderRadius: 15,
                    background: 'rgba(81, 21, 164,0.10)', color: '#5115a4',
                  }}
                >
                  <Icon className="w-[19px] h-[19px]" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate" style={{ color: '#1b1517' }}>{label}</p>
                  <p className="text-xs truncate" style={{ color: '#7d7174' }}>{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="text-xs" style={{ color: '#6b6063' }}>© 2026 Smilekit. Все права защищены.</p>
      </div>

      {/* Правая часть — форма */}
      <div className="flex-1 flex items-center justify-center p-8 relative z-10">
        <div className="w-full max-w-sm">
          {/* Логотип на мобильном */}
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div className="w-9 h-9 brand-mark flex-shrink-0" aria-hidden />
            <span className="brand-wordmark" style={{ color: '#1b1517' }}>smilekit crm</span>
          </div>

          <div
            className="p-8"
            style={{
              background: '#ffffff',
              border: '1px solid #ece5e5',
              borderRadius: 24,
              boxShadow: '0 1px 2px rgba(28,20,22,0.04), 0 24px 60px -34px rgba(28,20,22,0.24)',
            }}
          >
            <h1 style={{ fontSize: 25, fontWeight: 700, color: '#1b1517', letterSpacing: '-0.03em' }}>
              Войти в систему
            </h1>
            <p className="text-sm mb-7" style={{ color: '#7d7174', marginTop: 4 }}>
              Введите ваши данные для входа
            </p>

            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-1.5">
                <Label
                  className="uppercase"
                  style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: '#574d4f' }}
                >
                  Email
                </Label>
                <div className="relative">
                  <Mail
                    className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4"
                    style={{ color: '#a19698' }}
                  />
                  <input
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    className={`${inputClass} pl-10 pr-4`}
                    required
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label
                  className="uppercase"
                  style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.1em', color: '#574d4f' }}
                >
                  Пароль
                </Label>
                <div className="relative">
                  <Lock
                    className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4"
                    style={{ color: '#a19698' }}
                  />
                  <input
                    type={showPass ? 'text' : 'password'}
                    placeholder="••••••••"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className={`${inputClass} pl-10 pr-10`}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPass(!showPass)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 transition-colors"
                    style={{ color: '#7d7174' }}
                    aria-label={showPass ? 'Скрыть пароль' : 'Показать пароль'}
                  >
                    {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div
                  className="flex items-center gap-2 text-sm px-4 py-3"
                  style={{
                    background: '#fdeaea',
                    border: '1px solid #f5c9c9',
                    color: '#b91c1c',
                    borderRadius: 12,
                  }}
                >
                  <span className="text-base">⚠</span> {error}
                </div>
              )}

              <div className="flex justify-end">
                <a
                  href="/auth/forgot-password"
                  className="text-xs transition-colors hover:underline"
                  style={{ color: '#6b6063' }}
                >
                  Забыли пароль?
                </a>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full h-11 font-semibold text-white transition-all duration-200 mt-2 flex items-center justify-center gap-2 disabled:opacity-55"
                style={{
                  // Белый текст: на #8a68ad он даёт 2.84:1, поэтому градиент
                  // уходит в тёмную сторону красного (#360e7f → 5.71:1).
                  background: 'linear-gradient(135deg, #5115a4, #360e7f)',
                  borderRadius: 12,
                  boxShadow: '0 10px 24px -12px rgba(81, 21, 164,0.65)',
                }}
              >
                {loading ? (
                  <>
                    <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Входим...
                  </>
                ) : 'Войти →'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
