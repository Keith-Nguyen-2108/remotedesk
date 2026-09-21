const { app } = require('electron')
const http = require('http')
const { WebSocketServer } = require('ws')

app.whenReady().then(async () => {
  console.log('--- test 1: plain http.listen on a taken port ---')
  const r1 = await new Promise((resolve) => {
    const s = http.createServer()
    s.once('error', (e) => resolve('rejected: ' + e.code))
    s.listen(45789, '0.0.0.0', () => resolve('bound (unexpected)'))
    setTimeout(() => resolve('HUNG after 4s'), 4000)
  })
  console.log('  ->', r1)

  console.log('--- test 2: same, but with a WebSocketServer attached (as the app does) ---')
  const r2 = await new Promise((resolve) => {
    const s = http.createServer()
    const wss = new WebSocketServer({ server: s })
    wss.on('connection', () => {})
    s.once('error', (e) => resolve('rejected: ' + e.code))
    s.listen(45789, '0.0.0.0', () => resolve('bound (unexpected)'))
    setTimeout(() => resolve('HUNG after 4s'), 4000)
  })
  console.log('  ->', r2)

  app.quit()
})
