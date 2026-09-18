export const PROTOCOL_VERSION = 1

export const DEFAULT_SIGNAL_PORT = 45789
export const DISCOVERY_PORT = 45790
export const DISCOVERY_MAGIC = 'remotedesk-discover-v1'

export const FILE_CHUNK_SIZE = 16 * 1024
/** Stop pumping chunks once the data channel has this much queued. */
export const DATA_CHANNEL_HIGH_WATER = 4 * 1024 * 1024
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_KEY_CODE_LENGTH = 32
export const AUTH_TIMEOUT_MS = 10_000

export type MouseButton = 'left' | 'right' | 'middle'

export type InputMessage =
  | { t: 'move'; x: number; y: number }
  | { t: 'down'; b: MouseButton; x: number; y: number }
  | { t: 'up'; b: MouseButton; x: number; y: number }
  | { t: 'wheel'; dx: number; dy: number }
  | { t: 'keydown'; code: string }
  | { t: 'keyup'; code: string }

export type CtrlMessage =
  | { t: 'link'; url: string }
  | { t: 'clip-text'; text: string }
  | { t: 'clip-image'; dataUrl: string }
  | { t: 'file-begin'; id: string; name: string; size: number; mime: string }
  | { t: 'file-end'; id: string; sha256: string }
  | { t: 'file-ack'; id: string; ok: boolean; message?: string }
  | { t: 'screen-info'; width: number; height: number }

export interface IceCandidatePayload {
  candidate: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
  usernameFragment?: string | null
}

export type SignalMessage =
  | { t: 'challenge'; challenge: string; hostName: string; version: number }
  | { t: 'auth'; proof: string; clientName: string; version: number }
  | { t: 'auth-ok' }
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; candidate: IceCandidatePayload }
  | { t: 'bye'; reason: string }

const MOUSE_BUTTONS: readonly string[] = ['left', 'right', 'middle']

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isStr(v: unknown): v is string {
  return typeof v === 'string'
}

function isUnit(v: unknown): v is number {
  return isNum(v) && v >= 0 && v <= 1
}

function isKeyCode(v: unknown): v is string {
  return isStr(v) && v.length > 0 && v.length <= MAX_KEY_CODE_LENGTH
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function parseInputMessage(raw: unknown): InputMessage | null {
  if (!isObj(raw)) return null
  switch (raw.t) {
    case 'move':
      return isUnit(raw.x) && isUnit(raw.y) ? { t: 'move', x: raw.x, y: raw.y } : null
    case 'down':
    case 'up':
      return isUnit(raw.x) && isUnit(raw.y) && isStr(raw.b) && MOUSE_BUTTONS.includes(raw.b)
        ? { t: raw.t, b: raw.b as MouseButton, x: raw.x, y: raw.y }
        : null
    case 'wheel':
      return isNum(raw.dx) && isNum(raw.dy) ? { t: 'wheel', dx: raw.dx, dy: raw.dy } : null
    case 'keydown':
    case 'keyup':
      return isKeyCode(raw.code) ? { t: raw.t, code: raw.code } : null
    default:
      return null
  }
}

export function parseCtrlMessage(raw: unknown): CtrlMessage | null {
  if (!isObj(raw)) return null
  switch (raw.t) {
    case 'link':
      return isStr(raw.url) ? { t: 'link', url: raw.url } : null
    case 'clip-text':
      return isStr(raw.text) ? { t: 'clip-text', text: raw.text } : null
    case 'clip-image':
      return isStr(raw.dataUrl) ? { t: 'clip-image', dataUrl: raw.dataUrl } : null
    case 'file-begin':
      return isStr(raw.id) &&
        isStr(raw.name) &&
        isStr(raw.mime) &&
        isNum(raw.size) &&
        raw.size >= 0 &&
        raw.size <= MAX_FILE_BYTES
        ? { t: 'file-begin', id: raw.id, name: raw.name, size: raw.size, mime: raw.mime }
        : null
    case 'file-end':
      return isStr(raw.id) && isStr(raw.sha256)
        ? { t: 'file-end', id: raw.id, sha256: raw.sha256 }
        : null
    case 'file-ack':
      return isStr(raw.id) && typeof raw.ok === 'boolean'
        ? {
            t: 'file-ack',
            id: raw.id,
            ok: raw.ok,
            ...(isStr(raw.message) ? { message: raw.message } : {})
          }
        : null
    case 'screen-info':
      return isNum(raw.width) && isNum(raw.height) && raw.width > 0 && raw.height > 0
        ? { t: 'screen-info', width: raw.width, height: raw.height }
        : null
    default:
      return null
  }
}

function parseIce(raw: unknown): IceCandidatePayload | null {
  if (!isObj(raw) || !isStr(raw.candidate)) return null
  return {
    candidate: raw.candidate,
    sdpMid: isStr(raw.sdpMid) ? raw.sdpMid : null,
    sdpMLineIndex: isNum(raw.sdpMLineIndex) ? raw.sdpMLineIndex : null,
    usernameFragment: isStr(raw.usernameFragment) ? raw.usernameFragment : null
  }
}

export function parseSignalMessage(raw: unknown): SignalMessage | null {
  if (!isObj(raw)) return null
  switch (raw.t) {
    case 'challenge':
      return isStr(raw.challenge) && isStr(raw.hostName) && isNum(raw.version)
        ? { t: 'challenge', challenge: raw.challenge, hostName: raw.hostName, version: raw.version }
        : null
    case 'auth':
      return isStr(raw.proof) && isStr(raw.clientName) && isNum(raw.version)
        ? { t: 'auth', proof: raw.proof, clientName: raw.clientName, version: raw.version }
        : null
    case 'auth-ok':
      return { t: 'auth-ok' }
    case 'offer':
    case 'answer':
      return isStr(raw.sdp) ? { t: raw.t, sdp: raw.sdp } : null
    case 'ice': {
      const candidate = parseIce(raw.candidate)
      return candidate ? { t: 'ice', candidate } : null
    }
    case 'bye':
      return isStr(raw.reason) ? { t: 'bye', reason: raw.reason } : null
    default:
      return null
  }
}
