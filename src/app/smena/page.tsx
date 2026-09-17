import StaffPortal from '@/components/staff/StaffPortal'

// Публичная страница смены — без входа в CRM. Доступ даёт только пароль
// сотрудника (см. src/actions/staff-portal.ts).
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Смена — SmileKit', robots: { index: false } }

export default function SmenaPage() {
  return <StaffPortal />
}
