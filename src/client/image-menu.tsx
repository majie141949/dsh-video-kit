import { createRoot } from 'react-dom/client'
import { Menu } from 'dsh-tauri-ui/client'

export function imageMenu(controller: any) {
  let host: HTMLDivElement | undefined
  let root: ReturnType<typeof createRoot> | undefined
  function close() {
    const old = root
    root = undefined
    old?.unmount()
    host?.remove()
    host = undefined
  }
  controller.listenWindow('contextmenu', (event: MouseEvent) => {
    const image = event.target instanceof HTMLImageElement ? event.target : null
    if (!image || !image.closest('[data-slot="conversation.session"]')) return
    event.preventDefault()
    event.stopPropagation()
    close()
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const rect = new DOMRect(event.clientX, event.clientY, 0, 0)
    root.render(<Menu open portal autoFocus contextual align="start" items={[{ id: 'copy-image', label: '复制图片' }]} anchor={<span />} getAnchorRect={() => rect} onClose={close} onSelect={() => {
      close()
      try {
        if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined' || !image.complete || !image.naturalWidth) throw new Error('无法复制图片')
        const canvas = document.createElement('canvas')
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const context = canvas.getContext('2d')
        if (!context) throw new Error('无法读取图片')
        context.drawImage(image, 0, 0)
        const png = new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法复制图片')), 'image/png'))
        void navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]).catch((error) => alert(`复制图片失败：${error instanceof Error ? error.message : String(error)}`))
      } catch (error) { alert(`复制图片失败：${error instanceof Error ? error.message : String(error)}`) }
    }} />)
  }, { capture: true })
  controller.add(close)
}
