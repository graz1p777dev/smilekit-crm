import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import SalaryClient from '@/components/salary/SalaryClient'

export const dynamic = 'force-dynamic'

export default async function SalaryPage() {
  const supabase = await createClient()
  const { data: { session } } = await supabase.auth.getSession()

  const admin = createAdminClient()
  const [{ data: emps }, { data: me }] = await Promise.all([
    admin.from('employees').select('id, name').is('deleted_at', null).order('name'),
    session
      ? admin.from('employees').select('role').eq('user_id', session.user.id).is('deleted_at', null).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  return (
    <SalaryClient
      employees={(emps ?? []) as { id: string; name: string }[]}
      isOwner={(me as { role?: string } | null)?.role === 'owner'}
    />
  )
}
