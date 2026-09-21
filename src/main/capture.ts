import { desktopCapturer, session } from 'electron'

export interface ScreenChoice {
  id: string
  name: string
  thumbnailDataUrl: string
}

let selectedSourceId: string | null = null

export async function listScreens(): Promise<ScreenChoice[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 200 }
  })
  return sources.map((s) => ({
    id: s.id,
    name: s.name || 'Screen',
    thumbnailDataUrl: s.thumbnail.toDataURL()
  }))
}

export function setSelectedScreen(id: string | null): void {
  selectedSourceId = id
}

export function getSelectedScreen(): string | null {
  return selectedSourceId
}

/**
 * Electron routes getDisplayMedia() through main for consent. We answer with
 * the screen the user picked in the host UI, so the renderer never needs a
 * picker.
 *
 * The callback MUST be invoked on every path. getSources() rejects outright
 * when macOS Screen Recording permission is missing, and an unhandled
 * rejection here leaves getDisplayMedia() pending forever in the renderer -
 * the host then silently never builds an offer and the remote peer waits on a
 * screen that is never coming, with no error anywhere. Denying explicitly
 * (an empty response) makes getDisplayMedia() reject so the caller can say
 * why.
 */
export function registerDisplayMediaHandler(): void {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          const chosen = sources.find((s) => s.id === selectedSourceId) ?? sources[0]
          if (!chosen) {
            // An empty response denies the request.
            callback({})
            return
          }
          callback({ video: chosen })
        })
        .catch((err: unknown) => {
          console.error('screen capture unavailable:', err)
          callback({})
        })
    },
    { useSystemPicker: false }
  )
}
