/**
 * Metis Command — Electron main process.
 * Owns the lifecycle of the PTY sidecar and the Next.js server,
 * then opens a BrowserWindow at the rendered URL.
 */
const { app, BrowserWindow, shell, Menu, ipcMain, globalShortcut, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const IS_DEV = !app.isPackaged
// Force production mode unless explicitly requested. Production is more robust
// (no HMR cross-origin blocking, fewer 5xx during compile).
const USE_PROD = process.env.AW_NEXT_MODE !== 'dev' && fs.existsSync(path.join(PROJECT_ROOT, '.next', 'BUILD_ID'))
const NEXT_PORT = Number(process.env.AW_NEXT_PORT || 3760)
const PTY_PORT = Number(process.env.AW_PTY_PORT || 3761)
const PTY_HOST = process.env.AW_PTY_HOST || '127.0.0.1'
// Match Next.js's default canonical host (avoids cross-origin HMR/asset block in dev).
const APP_URL = `http://localhost:${NEXT_PORT}`

const CHILD_LOG_DIR = path.join(os.homedir(), '.openclaw', 'dev-review', 'electron-logs')
fs.mkdirSync(CHILD_LOG_DIR, { recursive: true })

const children = []

function spawnChild(name, cmd, args, opts = {}) {
  const log = fs.createWriteStream(path.join(CHILD_LOG_DIR, `${name}.log`), { flags: 'a' })
  const proc = spawn(cmd, args, {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  })
  log.write(`\n--- ${name} started ${new Date().toISOString()}: ${cmd} ${args.join(' ')}\n`)
  proc.stdout.on('data', (d) => { log.write(d); if (IS_DEV) process.stdout.write(`[${name}] ${d}`) })
  proc.stderr.on('data', (d) => { log.write(d); if (IS_DEV) process.stderr.write(`[${name}] ${d}`) })
  proc.on('exit', (code, signal) => {
    log.write(`--- ${name} exited code=${code} signal=${signal} ${new Date().toISOString()}\n`)
  })
  children.push(proc)
  return proc
}

function killChildren() {
  for (const c of children) {
    try { c.kill('SIGTERM') } catch {}
  }
}

function tcpProbe(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const net = require('node:net')
    const sock = new net.Socket()
    let done = false
    const finish = (ok) => { if (done) return; done = true; try { sock.destroy() } catch {}; resolve(ok) }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
    sock.connect(port, host)
  })
}

async function waitForUrl(url, timeoutMs = 30000) {
  const u = new URL(url)
  const port = Number(u.port || 80)
  const host = u.hostname
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  while (Date.now() < deadline) {
    attempts++
    if (await tcpProbe(host, port, 800)) {
      console.log(`[main] ${url} reachable after ${attempts} attempt(s)`)
      return true
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  console.log(`[main] timed out waiting for ${url}`)
  return false
}

function startServers() {
  const electronBin = process.execPath
  const ptyServerTs = path.join(PROJECT_ROOT, 'server', 'pty-server.ts')
  const ptyServerCjs = path.join(PROJECT_ROOT, 'server', 'pty-server.cjs')
  const useCompiled = fs.existsSync(ptyServerCjs)

  // PTY sidecar
  if (app.isPackaged) {
    // run packed Electron as Node, executing pre-compiled JS or stripping types from TS
    if (useCompiled) {
      spawnChild('pty', electronBin, [ptyServerCjs], {
        env: { ELECTRON_RUN_AS_NODE: '1', AW_PTY_PORT: String(PTY_PORT), AW_PTY_HOST: PTY_HOST },
      })
    } else {
      spawnChild('pty', electronBin, ['--experimental-strip-types', ptyServerTs], {
        env: { ELECTRON_RUN_AS_NODE: '1', AW_PTY_PORT: String(PTY_PORT), AW_PTY_HOST: PTY_HOST },
      })
    }
  } else {
    const tsxBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx')
    spawnChild('pty', tsxBin, ['server/pty-server.ts'], {
      env: { AW_PTY_PORT: String(PTY_PORT), AW_PTY_HOST: PTY_HOST },
    })
  }

  // Next.js
  if (app.isPackaged) {
    const nextBinJs = path.join(PROJECT_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next')
    spawnChild('next', electronBin, [nextBinJs, 'start', '-p', String(NEXT_PORT)], {
      env: { ELECTRON_RUN_AS_NODE: '1', NODE_NO_WARNINGS: '1' },
    })
  } else {
    const nextBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'next')
    if (USE_PROD) spawnChild('next', nextBin, ['start', '-p', String(NEXT_PORT)])
    else spawnChild('next', nextBin, ['dev', '-p', String(NEXT_PORT)])
  }
}

let mainWindow = null
let hudWindow = null

function toggleHud() {
  if (hudWindow && !hudWindow.isDestroyed()) {
    if (hudWindow.isVisible()) hudWindow.hide()
    else { hudWindow.show(); hudWindow.focus() }
    return
  }
  const display = screen.getPrimaryDisplay().workArea
  const W = 360, H = 220
  hudWindow = new BrowserWindow({
    width: W,
    height: H,
    x: display.x + display.width - W - 24,
    y: display.y + 24,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    skipTaskbar: true,
    title: 'Jarvis',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  hudWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  hudWindow.loadFile(path.join(__dirname, 'hud.html'))
  hudWindow.on('closed', () => { hudWindow = null })
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#05060a',
    titleBarStyle: 'hiddenInset',
    title: 'Metis Command',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    show: false,
  })

  console.log('[main] window created, loading splash')
  await mainWindow.loadFile(path.join(__dirname, 'splash.html'))
  mainWindow.show()

  console.log('[main] waiting for', APP_URL)
  const ready = await waitForUrl(APP_URL, 60000)
  if (!ready) {
    console.log('[main] not ready, staying on splash')
    return
  }
  console.log('[main] loading workbench URL')
  await mainWindow.loadURL(APP_URL)
  console.log('[main] workbench loaded')

  // Pipe renderer console + errors to stdout for diagnostics
  mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`[renderer:${level}] ${message}`)
  })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[renderer:gone] reason=${details.reason} exitCode=${details.exitCode}`)
  })
  if (process.env.AW_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' }
    }
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.on('ready', async () => {
  startServers()
  await createWindow()
  Menu.setApplicationMenu(buildMenu())
  // Global hotkey for the floating Jarvis HUD
  try { globalShortcut.register('CommandOrControl+Shift+J', toggleHud) } catch (e) {
    console.log('[main] could not register HUD hotkey:', e.message)
  }
})

app.on('will-quit', () => { try { globalShortcut.unregisterAll() } catch {} })

app.on('window-all-closed', () => {
  killChildren()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', killChildren)

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow()
})

ipcMain.handle('aw:open-external', (_e, url) => shell.openExternal(url))
ipcMain.handle('aw:get-config', () => ({
  ptyPort: PTY_PORT,
  ptyHost: PTY_HOST,
  nextPort: NEXT_PORT,
  appUrl: APP_URL,
  isDev: IS_DEV,
}))

function buildMenu() {
  const isMac = process.platform === 'darwin'
  return Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Reload Workbench', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Metis HUD', accelerator: 'CmdOrCtrl+Shift+J', click: toggleHud },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ])
}
