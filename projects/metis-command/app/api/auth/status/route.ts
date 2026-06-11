import { NextResponse } from 'next/server'
import { getAuthStatus } from '@/lib/auth-status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const status = await getAuthStatus()
  return NextResponse.json(status)
}
