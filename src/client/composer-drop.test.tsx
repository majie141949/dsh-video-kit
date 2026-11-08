import { afterEach, expect, it, vi } from 'vitest'
import { composerDragOver, composerDrop } from './composer-drop'

class Transfer {
  files: File[] = []
  private values: Record<string, string> = {}
  items = { add: (file: File) => { this.files.push(file) }, [Symbol.iterator]: () => [][Symbol.iterator]() }
  get types() { return Object.keys(this.values) }
  getData(type: string) { return this.values[type] || '' }
  setData(type: string, value: string) { this.values[type] = value }
}
class Clipboard extends Event {
  clipboardData: Transfer
  constructor(type: string, options: any) { super(type, options); this.clipboardData = options.clipboardData }
}
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals() })

it('drops a conversation blob as a real image attachment without changing the draft', async () => {
  vi.stubGlobal('DataTransfer', Transfer)
  vi.stubGlobal('ClipboardEvent', Clipboard)
  const blob = new Blob(['photo'], { type: 'image/jpeg' })
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => blob })))
  document.body.innerHTML = '<div data-composer-card><div data-composer-input contenteditable="true">原始文字</div></div>'
  const editor = document.querySelector('[data-composer-input]') as HTMLElement
  let received: File | undefined
  editor.addEventListener('paste', event => { received = (event as ClipboardEvent).clipboardData?.files[0]; event.preventDefault() })
  const transfer = new Transfer()
  transfer.setData('text/plain', 'blob:http://localhost/image')
  const drag = new Event('dragover', { bubbles: true, cancelable: true })
  Object.defineProperty(drag, 'dataTransfer', { value: transfer })
  editor.addEventListener('dragover', composerDragOver as EventListener)
  editor.dispatchEvent(drag)
  expect(drag.defaultPrevented).toBe(true)
  const drop = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: transfer })
  editor.addEventListener('drop', composerDrop as EventListener)
  editor.dispatchEvent(drop)
  expect(drop.defaultPrevented).toBe(true)
  await vi.waitFor(() => expect(received?.type).toBe('image/jpeg'))
  expect(received?.size).toBe(5)
  expect(editor.textContent).toBe('原始文字')
})

it('leaves ordinary text drops to the editor', () => {
  document.body.innerHTML = '<div data-composer-card><div data-composer-input contenteditable="true">原文</div></div>'
  const editor = document.querySelector('[data-composer-input]') as HTMLElement
  const transfer = new Transfer()
  transfer.setData('text/plain', '普通文字')
  const drop = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(drop, 'dataTransfer', { value: transfer })
  editor.addEventListener('drop', composerDrop as EventListener)
  editor.dispatchEvent(drop)
  expect(drop.defaultPrevented).toBe(false)
})
