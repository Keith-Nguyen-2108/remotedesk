import type { RdApi } from '../preload/index'

declare global {
  interface Window {
    rd: RdApi
  }
}
