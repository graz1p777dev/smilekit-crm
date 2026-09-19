import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
const { deliveryPatch } = await import('./delivery-status')

describe('deliveryPatch', () => {
  const at = '2026-09-19T10:00:00.000Z'
  it('доставлено', () => expect(deliveryPatch('delivered', at)).toEqual({ delivered_at: at }))
  it('прочитано — значит и доставлено', () => expect(deliveryPatch('read', at)).toEqual({ delivered_at: at, read_at: at }))
  it('прочие статусы не трогают поля', () => {
    expect(deliveryPatch('sent', at)).toBeNull()
    expect(deliveryPatch('failed', at)).toBeNull()
    expect(deliveryPatch(undefined, at)).toBeNull()
  })
})
