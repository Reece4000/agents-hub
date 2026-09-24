import type { Viewport } from './types'
// Zoom anchored at a screen point, so ctrl+wheel/trackpad pinch keeps the cursor stable.
// Pure math: the caller applies the result with setViewport.
export function zoomAtCursor(viewport:Viewport,x:number,y:number,deltaY:number,deltaMode:number,minZoom=.05,maxZoom=2):Viewport {
  const normalized=deltaMode===1?deltaY*16:deltaMode===2?deltaY*400:deltaY
  const zoom=Math.min(maxZoom,Math.max(minZoom,viewport.zoom*Math.pow(2,-normalized*.01)))
  if(zoom===viewport.zoom)return viewport
  const fx=(x-viewport.x)/viewport.zoom,fy=(y-viewport.y)/viewport.zoom
  return {x:x-fx*zoom,y:y-fy*zoom,zoom}
}
export function centerOnNode(containerWidth:number,containerHeight:number,position:{x:number;y:number},width:number,height:number,zoom:number):Viewport {
  return { x: containerWidth / 2 - (position.x + width / 2) * zoom, y: containerHeight / 2 - (position.y + height / 2) * zoom, zoom }
}
