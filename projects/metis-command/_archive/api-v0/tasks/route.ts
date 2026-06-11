import { NextRequest, NextResponse } from 'next/server'
import { getState, updateTaskStatus } from '@/lib/store'
import type { TaskStatus } from '@/lib/types'

export async function GET() {
  const state = await getState()
  return NextResponse.json(state)
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json() as { taskId?: string; status?: TaskStatus }
    if (!body.taskId || !body.status) {
      return NextResponse.json({ error: 'taskId and status are required' }, { status: 400 })
    }
    const task = await updateTaskStatus(body.taskId, body.status)
    return NextResponse.json({ task })
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unknown error' }, { status: 400 })
  }
}
