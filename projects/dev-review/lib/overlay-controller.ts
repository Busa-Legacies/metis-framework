/**
 * Overlay controller — drives element picking + annotation pins on a
 * SAME-ORIGIN iframe's document, operated entirely from the parent window.
 * No script injection, no postMessage: for our all-localhost review targets
 * the parent can touch contentDocument directly, which sidesteps CSP and
 * keeps one source of truth (forge draft, corrected: every DOM/style/scroll
 * call must hit the iframe's document/window, never the parent's).
 */

export interface PickResult {
  selector: string
  rect: { x: number; y: number; width: number; height: number }
  styles: Record<string, string>
}

export interface PinInput {
  id: string
  selector: string
  status: 'open' | 'resolved' | 'orphaned' | 'changed'
}

export interface OverlayController {
  setPicking(on: boolean): void
  renderPins(pins: PinInput[]): void
  dispose(): void
}

const OBSERVER_DEBOUNCE_MS = 300
const STYLE_KEYS = [
  'color', 'background-color', 'font-size', 'font-family',
  'padding', 'margin', 'display', 'position',
] as const

/** Classes that look build-hashed make brittle selectors — skip them. */
export function isStableClass(cls: string): boolean {
  return !/\d/.test(cls) && !cls.includes('__') && cls.length <= 24
}

function cssEscape(doc: Document, value: string): string {
  const win = doc.defaultView
  return win && 'CSS' in win ? win.CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

/** Build a selector matching exactly one element IN THE IFRAME DOC. */
function buildSelector(doc: Document, el: Element): string {
  const unique = (sel: string): boolean => {
    try { return doc.querySelectorAll(sel).length === 1 } catch { return false }
  }

  if (el.id) {
    const sel = `#${cssEscape(doc, el.id)}`
    if (unique(sel)) return sel
  }

  for (const attr of Array.from(el.attributes)) {
    if (attr.name.startsWith('data-') && attr.value) {
      const sel = `[${attr.name}="${attr.value.replace(/"/g, '\\"')}"]`
      if (unique(sel)) return sel
    }
  }

  const stable = Array.from(el.classList).filter(isStableClass)
  if (stable.length > 0) {
    const sel = `${el.tagName.toLowerCase()}.${stable.map((c) => cssEscape(doc, c)).join('.')}`
    if (unique(sel)) return sel
  }

  // Structural path: climb until an id-anchored or unique prefix is found,
  // qualifying each hop with :nth-of-type.
  const parts: string[] = []
  let node: Element | null = el
  while (node && node !== doc.body && node.parentElement) {
    const parent: Element = node.parentElement
    const tag = node.tagName.toLowerCase()
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === node!.tagName)
    const hop = sameTag.length > 1
      ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})`
      : tag
    parts.unshift(hop)
    if (parent.id) {
      const sel = `#${cssEscape(doc, parent.id)} > ${parts.join(' > ')}`
      if (unique(sel)) return sel
    }
    const candidate = `body > ${parts.join(' > ')}`
    if (parent === doc.body && unique(candidate)) return candidate
    node = parent
  }
  return `body > ${parts.join(' > ')}`
}

export function createOverlayController(
  iframe: HTMLIFrameElement,
  opts: { onPick: (r: PickResult) => void; onOrphan: (ids: string[]) => void },
): OverlayController {
  let picking = false
  let currentPins: PinInput[] = []
  let hoverBox: HTMLDivElement | null = null
  let badges: HTMLDivElement[] = []
  let observer: MutationObserver | null = null
  let debounceTimer: number | null = null
  const reportedOrphans = new Set<string>()

  function getDoc(): Document | null {
    try {
      const doc = iframe.contentDocument
      // Touch body to force a cross-origin throw rather than a null deref later.
      return doc && doc.body ? doc : null
    } catch {
      return null
    }
  }

  function clearHoverBox() {
    hoverBox?.remove()
    hoverBox = null
  }

  function clearBadges() {
    badges.forEach((b) => b.remove())
    badges = []
  }

  function pageRect(doc: Document, el: Element) {
    const r = el.getBoundingClientRect()
    const win = doc.defaultView
    const sx = win?.scrollX ?? 0
    const sy = win?.scrollY ?? 0
    return { x: r.left + sx, y: r.top + sy, width: r.width, height: r.height }
  }

  function onMouseMove(e: MouseEvent) {
    const doc = getDoc()
    if (!doc || !picking) return
    const target = e.target as Element | null
    if (!target || target === hoverBox) return
    if (!hoverBox) {
      hoverBox = doc.createElement('div')
      Object.assign(hoverBox.style, {
        position: 'absolute', pointerEvents: 'none', boxSizing: 'border-box',
        border: '2px solid #34d3ff', zIndex: '999998',
      })
      doc.body.appendChild(hoverBox)
    }
    const rect = pageRect(doc, target)
    Object.assign(hoverBox.style, {
      left: `${rect.x}px`, top: `${rect.y}px`,
      width: `${rect.width}px`, height: `${rect.height}px`,
    })
  }

  function onClick(e: MouseEvent) {
    const doc = getDoc()
    if (!doc || !picking) return
    e.preventDefault()
    e.stopPropagation()
    const target = e.target as Element | null
    if (!target) return
    const win = doc.defaultView
    const computed = win ? win.getComputedStyle(target) : null
    const styles: Record<string, string> = {}
    if (computed) for (const k of STYLE_KEYS) styles[k] = computed.getPropertyValue(k)
    opts.onPick({ selector: buildSelector(doc, target), rect: pageRect(doc, target), styles })
    setPickingState(false)
  }

  function setPickingState(on: boolean) {
    picking = on
    if (!on) clearHoverBox()
  }

  function positionBadges() {
    const doc = getDoc()
    if (!doc) return
    clearBadges()
    const visible = currentPins.filter((p) => p.status !== 'orphaned')
    visible.forEach((pin, i) => {
      let el: Element | null = null
      try {
        const matches = doc.querySelectorAll(pin.selector)
        if (matches.length === 1) el = matches[0]
      } catch { /* invalid selector → treated as orphan by observer pass */ }
      if (!el) return
      const rect = pageRect(doc, el)
      const badge = doc.createElement('div')
      badge.textContent = String(i + 1)
      Object.assign(badge.style, {
        position: 'absolute', left: `${rect.x + rect.width - 8}px`, top: `${rect.y - 8}px`,
        width: '16px', height: '16px', borderRadius: '50%',
        background: pin.status === 'changed' ? '#f59e0b' : '#34d3ff', color: '#05060a',
        font: '10px ui-monospace, monospace', lineHeight: '16px', textAlign: 'center',
        zIndex: '999999', pointerEvents: 'none',
        opacity: pin.status === 'resolved' ? '0.4' : '1',
      })
      doc.body.appendChild(badge)
      badges.push(badge)
    })
  }

  function checkOrphans() {
    const doc = getDoc()
    if (!doc) return
    const orphaned: string[] = []
    for (const pin of currentPins) {
      if (pin.status === 'orphaned') continue
      let count = 0
      try { count = doc.querySelectorAll(pin.selector).length } catch { count = 0 }
      if (count !== 1 && !reportedOrphans.has(pin.id)) {
        reportedOrphans.add(pin.id)
        orphaned.push(pin.id)
      }
    }
    if (orphaned.length) opts.onOrphan(orphaned)
    positionBadges()
  }

  function onMutations() {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(checkOrphans, OBSERVER_DEBOUNCE_MS)
  }

  function attach() {
    const doc = getDoc()
    if (!doc) return
    doc.addEventListener('mousemove', onMouseMove, true)
    doc.addEventListener('click', onClick, true)
    doc.defaultView?.addEventListener('scroll', positionBadges, true)
    doc.defaultView?.addEventListener('resize', positionBadges)
    observer = new MutationObserver(onMutations)
    observer.observe(doc.body, { childList: true, subtree: true })
    positionBadges()
  }

  function detach() {
    const doc = getDoc()
    if (doc) {
      doc.removeEventListener('mousemove', onMouseMove, true)
      doc.removeEventListener('click', onClick, true)
      doc.defaultView?.removeEventListener('scroll', positionBadges, true)
      doc.defaultView?.removeEventListener('resize', positionBadges)
    }
    observer?.disconnect()
    observer = null
    clearHoverBox()
    clearBadges()
  }

  function onLoad() {
    // Navigation/hot-reload replaced the document: pins must re-anchor or orphan.
    detach()
    reportedOrphans.clear()
    attach()
    checkOrphans()
  }

  iframe.addEventListener('load', onLoad)
  attach()

  return {
    setPicking: setPickingState,
    renderPins(pins: PinInput[]) {
      currentPins = pins
      positionBadges()
    },
    dispose() {
      iframe.removeEventListener('load', onLoad)
      if (debounceTimer !== null) window.clearTimeout(debounceTimer)
      detach()
    },
  }
}
