import './styles.css'
import { createClientView } from './ui/client-view'
import { createHostView } from './ui/host-view'

type Role = 'host' | 'client'

const app = document.querySelector<HTMLDivElement>('#app')!
let current: HTMLElement | null = null

function render(role: Role): void {
  current?.remove()
  current = role === 'host' ? createHostView() : createClientView()
  app.append(current)
}

const tabs = document.createElement('nav')
tabs.className = 'tabs'
tabs.innerHTML = `
  <button data-role="client" class="active">Control a machine</button>
  <button data-role="host">Share this machine</button>
  <span id="who"></span>
`
app.append(tabs)

tabs.addEventListener('click', (event) => {
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-role]')
  if (!btn) return
  tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn))
  render(btn.dataset.role as Role)
})

void window.rd.identity().then((id) => {
  const who = tabs.querySelector<HTMLElement>('#who')
  if (who) {
    const { machineName, platform } = id as { machineName: string; platform: string }
    who.textContent = `${machineName} - ${platform}`
  }
})

render('client')
