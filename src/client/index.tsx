import type { ClientContext } from 'dsh-tauri/client'
import { definePanel, defineRegister } from 'dsh-tauri/client'
import { PLUGIN_ID } from '../shared/constants'
import { VideoPanel } from './panel'
import { VideoModels } from './video-models'
import { composerDragOver, composerDrop } from './composer-drop'
import { imageMenu } from './image-menu'

const icon = (props: { size: number, active: boolean }) => (
  <svg width={props.size} height={props.size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2.5" y="6" width="19" height="14" rx="2.5" />
    <path d="M2.5 10.5h19" />
    <path d="M7 6l2.2-3.2M12.2 6l2.2-3.2M17.4 6l2.2-3.2" />
    <path d="M10.5 13.2v4.2l3.8-2.1z" fill="currentColor" stroke="none" />
  </svg>
)

const panelFeature = defineRegister<ClientContext>((controller, ctx) => {
  imageMenu(controller)
  controller.listen('dragover', composerDragOver, { capture: true })
  controller.listen('drop', composerDrop, { capture: true })
  const panel = definePanel(ctx, {
    id: PLUGIN_ID,
    order: 55,
    label: () => '视频',
    icon,
    render: () => <VideoPanel />,
  })
  controller.add(panel.dispose)
  controller.add(ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer', id: 'video-models', order: 50,
  }, VideoModels)))
})

export const name = PLUGIN_ID
export const inject = ['slots', 'layout']

export function apply(ctx: ClientContext): void {
  ctx.effect(panelFeature, `${PLUGIN_ID}: panel`)
}
