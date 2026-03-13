import type { Response } from 'express'
import { getQueueItemById, serializeQueueItemSummary } from './queueStore.js'

type QueueEvent =
  | { type: 'item-upserted'; item: ReturnType<typeof serializeQueueItemSummary> }
  | { type: 'item-deleted'; itemId: string }

const clients = new Map<string, Set<Response>>()

function write(res: Response, event: QueueEvent): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

export function registerQueueSse(clientId: string, res: Response): () => void {
  const set = clients.get(clientId) ?? new Set<Response>()
  set.add(res)
  clients.set(clientId, set)
  res.write(': connected\n\n')

  return () => {
    const active = clients.get(clientId)
    if (!active) return
    active.delete(res)
    if (active.size === 0) {
      clients.delete(clientId)
    }
  }
}

export function emitQueueItemUpsert(itemId: string): void {
  const row = getQueueItemById(itemId)
  if (!row || row.hidden) return
  const listeners = clients.get(row.client_id)
  if (!listeners?.size) return
  const event: QueueEvent = { type: 'item-upserted', item: serializeQueueItemSummary(row) }
  for (const res of listeners) write(res, event)
}

export function emitQueueItemDeleted(clientId: string, itemId: string): void {
  const listeners = clients.get(clientId)
  if (!listeners?.size) return
  const event: QueueEvent = { type: 'item-deleted', itemId }
  for (const res of listeners) write(res, event)
}
