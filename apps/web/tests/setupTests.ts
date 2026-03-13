import '@testing-library/jest-dom/vitest'

class MockEventSource {
  url: string
  withCredentials: boolean
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null

  constructor(url: string, options?: EventSourceInit) {
    this.url = url
    this.withCredentials = !!options?.withCredentials
  }

  close() {}
}

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
})

Object.defineProperty(window, 'EventSource', {
  writable: true,
  value: MockEventSource,
})

Object.defineProperty(window, 'scrollTo', {
  writable: true,
  value: () => {},
})
