import { RelayServer } from './relay-server'

const port = Number(process.env.PORT ?? 8080)

const server = new RelayServer()
server
  .start(port)
  .then((boundPort) => {
    // eslint-disable-next-line no-console
    console.log(`remotedesk-relay listening on :${boundPort}`)
  })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('failed to start relay server:', err)
    process.exit(1)
  })

function shutdown(): void {
  void server.stop().then(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
