'use client'
import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Search, LayoutDashboard, BarChart3, DollarSign, Users, Settings, Handshake, Package } from 'lucide-react'

const commands = [
  { label: 'Дашборд', href: '/dashboard', icon: LayoutDashboard, category: 'Навигация' },
  { label: 'Сделки', href: '/dashboard/deals', icon: Handshake, category: 'Навигация' },
  { label: 'Заказы', href: '/dashboard/orders', icon: Package, category: 'Навигация' },
  { label: 'Декомпозиция / KPI', href: '/dashboard/decomposition', icon: BarChart3, category: 'Навигация' },
  { label: 'Зарплата', href: '/dashboard/salary', icon: DollarSign, category: 'Навигация' },
  { label: 'Сотрудники', href: '/dashboard/employees', icon: Users, category: 'Управление' },
  { label: 'Настройки KPI', href: '/dashboard/settings', icon: Settings, category: 'Управление' },
]

export default function CommandPalette() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const router = useRouter()

  const filtered = commands.filter(c =>
    c.label.toLowerCase().includes(query.toLowerCase())
  )

  const execute = useCallback((href: string) => {
    router.push(href)
    setOpen(false)
    setQuery('')
    setSelected(0)
  }, [router])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || e.key === '/') {
        e.preventDefault()
        setOpen(o => !o)
      }
      if (!open) return
      if (e.key === 'Escape') { setOpen(false); setQuery(''); setSelected(0) }
      if (e.key === 'ArrowDown') setSelected(s => Math.min(s + 1, filtered.length - 1))
      if (e.key === 'ArrowUp') setSelected(s => Math.max(s - 1, 0))
      if (e.key === 'Enter' && filtered[selected]) execute(filtered[selected].href)
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [open, filtered, selected, execute])

  useEffect(() => { setSelected(0) }, [query])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh] bg-black/60 backdrop-blur-sm"
      onClick={() => { setOpen(false); setQuery(''); setSelected(0) }}
    >
      <div
        className="w-full max-w-lg mx-4 bg-gray-900 border border-white/10 rounded-2xl shadow-2xl shadow-black/60 overflow-hidden animate-fade-in"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-4 border-b border-white/8">
          <Search className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Поиск по системе..."
            className="flex-1 bg-transparent text-gray-100 placeholder:text-gray-500 text-sm outline-none"
          />
          <kbd className="text-[10px] text-gray-600 bg-white/5 border border-white/10 px-1.5 py-0.5 rounded font-mono">ESC</kbd>
        </div>

        {/* Results */}
        <div className="py-2 max-h-80 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-gray-500 text-sm">Ничего не найдено</div>
          ) : (
            filtered.map((cmd, i) => {
              const Icon = cmd.icon
              const isSelected = i === selected
              return (
                <button
                  key={cmd.href}
                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${isSelected ? 'bg-[#5115a4]/20' : 'hover:bg-white/5'}`}
                  onClick={() => execute(cmd.href)}
                  onMouseEnter={() => setSelected(i)}
                >
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${isSelected ? 'bg-[#5115a4]' : 'bg-white/8'}`}>
                    <Icon className={`w-3.5 h-3.5 ${isSelected ? 'text-white' : 'text-gray-400'}`} />
                  </div>
                  <div>
                    <p className={`text-sm font-medium ${isSelected ? 'text-[#c4a6ea]' : 'text-gray-300'}`}>{cmd.label}</p>
                    <p className="text-[11px] text-gray-600">{cmd.category}</p>
                  </div>
                  {isSelected && (
                    <kbd className="ml-auto text-[10px] text-gray-500 bg-white/5 border border-white/10 px-1.5 py-0.5 rounded font-mono">↵</kbd>
                  )}
                </button>
              )
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 border-t border-white/5 flex items-center gap-4 text-[11px] text-gray-600">
          <span><kbd className="font-mono bg-white/5 px-1 rounded">↑↓</kbd> навигация</span>
          <span><kbd className="font-mono bg-white/5 px-1 rounded">↵</kbd> открыть</span>
          <span><kbd className="font-mono bg-white/5 px-1 rounded">esc</kbd> закрыть</span>
        </div>
      </div>
    </div>
  )
}
