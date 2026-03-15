const activeClientUploads = new Map<string, number>()

function setClientUploads(clientId: string, count: number): void {
  if (count <= 0) {
    activeClientUploads.delete(clientId)
    return
  }
  activeClientUploads.set(clientId, count)
}

export function beginClientUpload(clientId: string): () => void {
  setClientUploads(clientId, (activeClientUploads.get(clientId) || 0) + 1)

  let released = false
  return () => {
    if (released) return
    released = true
    setClientUploads(clientId, (activeClientUploads.get(clientId) || 0) - 1)
  }
}

export function getActiveClientUploads(clientId: string): number {
  return activeClientUploads.get(clientId) || 0
}
