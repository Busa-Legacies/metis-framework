import { NextRequest, NextResponse } from 'next/server'
import { createDispatch, getState } from '@/lib/store'
import type { AgentTarget } from '@/lib/types'

export async function GET() {
  const state = await getState()
  return NextResponse.json({ dispatches: state.dispatches })
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { taskId?: string; target?: AgentTarget; prompt?: string }
    if (!body.taskId || !body.target || !body.prompt) {
      return NextResponse.json({ error: 'taskId, target, and prompt are required' }, { status: 400 })
    }
    const dispatch = await createDispatch(body.taskId, body.target, body.prompt)
    return NextResponse.json({ dispatch })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 400 })
  }
}
