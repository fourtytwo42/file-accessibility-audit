'use client'

import { useMemo, useState } from 'react'

export function useSelection() {
  const [selectedIds, setSelectedIds] = useState<string[]>([])

  function toggle(id: string) {
    setSelectedIds(current => current.includes(id) ? current.filter(entry => entry !== id) : [...current, id])
  }

  function clear() {
    setSelectedIds([])
  }

  function selectPage(ids: string[]) {
    setSelectedIds(current => Array.from(new Set([...current, ...ids])))
  }

  function clearPage(ids: string[]) {
    setSelectedIds(current => current.filter(id => !ids.includes(id)))
  }

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  return {
    selectedIds,
    selectedSet,
    toggle,
    clear,
    selectPage,
    clearPage,
  }
}
