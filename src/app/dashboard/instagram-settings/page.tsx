import { getInstagramStatus } from '@/actions/instagram-settings'
import InstagramSettingsClient from '@/components/instagram/InstagramSettingsClient'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Instagram — Smilekit' }

export default async function InstagramSettingsPage() {
  const integration = await getInstagramStatus()
  if (!integration) return <div className="p-8 text-sm text-gray-400">Нет доступа</div>

  return <InstagramSettingsClient initialIntegration={integration} />
}
