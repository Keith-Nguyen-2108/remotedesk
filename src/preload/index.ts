import { contextBridge } from 'electron'

const api = {
  version: '0.1.0'
}

contextBridge.exposeInMainWorld('rd', api)

export type RdApi = typeof api
