import { ShareList, type ShareItem } from '../../shared/shares'

const COPY_FLASH_MS = 1200

function relativeLabel(receivedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - receivedAt) / 1000))
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.round(minutes / 60)}h ago`
}

/**
 * Everything the other machine has shared - text, links, images, files -
 * shown as cards the user can reuse on demand instead of anything being
 * applied automatically. Hovering a card reveals its action button(s) in the
 * bottom-right corner. Nothing here is persisted: it is an in-memory list
 * that starts empty on every launch.
 */
export class SharesPanel {
  readonly el: HTMLElement
  private readonly list: HTMLUListElement
  private readonly empty: HTMLElement
  private readonly items = new ShareList()

  constructor() {
    this.el = document.createElement('section')
    this.el.className = 'card shares'

    const heading = document.createElement('h2')
    heading.textContent = 'Shares'

    this.empty = document.createElement('p')
    this.empty.className = 'hint'
    this.empty.textContent = 'Nothing shared yet.'

    this.list = document.createElement('ul')
    this.list.className = 'shares-list'

    this.el.append(heading, this.empty, this.list)
  }

  addText(text: string): void {
    this.render(this.items.add({ kind: 'text', text }))
  }

  addLink(url: string): void {
    this.render(this.items.add({ kind: 'link', url }))
  }

  addImage(dataUrl: string): void {
    this.render(this.items.add({ kind: 'image', dataUrl }))
  }

  addFile(name: string, path: string): void {
    this.render(this.items.add({ kind: 'file', name, path }))
  }

  private render(item: ShareItem): void {
    this.empty.hidden = true
    this.list.prepend(this.buildRow(item))
  }

  private buildRow(item: ShareItem): HTMLLIElement {
    const li = document.createElement('li')
    li.className = `share-item share-${item.kind}`

    const body = document.createElement('div')
    body.className = 'share-body'
    li.append(body)

    // .textContent everywhere below: this content came from the network peer
    // and must never be interpreted as markup.
    if (item.kind === 'text') {
      const p = document.createElement('p')
      p.className = 'share-text'
      p.textContent = item.text
      body.append(p)
    } else if (item.kind === 'link') {
      const p = document.createElement('p')
      p.className = 'share-text share-link'
      p.textContent = item.url
      body.append(p)
    } else if (item.kind === 'image') {
      const img = document.createElement('img')
      img.className = 'share-thumb'
      img.src = item.dataUrl
      img.alt = 'Shared image'
      body.append(img)
    } else {
      const p = document.createElement('p')
      p.className = 'share-text'
      p.textContent = item.name
      body.append(p)
    }

    const time = document.createElement('span')
    time.className = 'share-time'
    time.textContent = relativeLabel(item.receivedAt)
    li.append(time)

    const actions = document.createElement('div')
    actions.className = 'share-actions'
    li.append(actions)

    if (item.kind === 'text') {
      actions.append(this.copyButton(() => this.copyText(item.text)))
    } else if (item.kind === 'link') {
      actions.append(this.copyButton(() => this.copyText(item.url)))
    } else if (item.kind === 'image') {
      actions.append(
        this.copyButton(() => this.copyImage(item.dataUrl)),
        this.previewButton(item.dataUrl)
      )
    } else {
      const reveal = document.createElement('button')
      reveal.type = 'button'
      reveal.className = 'share-action'
      reveal.textContent = 'Show in folder'
      reveal.onclick = () => void window.rd.files.reveal(item.path)
      actions.append(reveal)
    }

    return li
  }

  private copyText(text: string): void {
    void window.rd.clipboard.applyRemote({ kind: 'text', text })
  }

  private copyImage(dataUrl: string): void {
    void window.rd.clipboard.applyRemote({ kind: 'image', dataUrl })
  }

  private copyButton(onCopy: () => void): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'share-action'
    btn.textContent = 'Copy'
    btn.onclick = () => {
      onCopy()
      btn.textContent = 'Copied'
      btn.disabled = true
      setTimeout(() => {
        btn.textContent = 'Copy'
        btn.disabled = false
      }, COPY_FLASH_MS)
    }
    return btn
  }

  private previewButton(dataUrl: string): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'share-action'
    btn.textContent = 'Preview'
    btn.onclick = () => void window.rd.files.previewImage(dataUrl)
    return btn
  }
}
