const { app, BrowserWindow, dialog } = require('electron')
const { startServices, stopServices, PORTS } = require('./services.cjs')

// Production = the packaged app (or ANTRAL_PROD=1 to test the prod path locally).
// In production Electron starts the bundled services and loads the app from the
// gateway, which serves the built frontend. In development it loads the Vite
// dev server, and the services are started separately by `npm run desktop`.
const isProd = () => app.isPackaged || process.env.ANTRAL_PROD === '1'
const appUrl = () => (isProd() ? `http://127.0.0.1:${PORTS.gateway}` : 'http://localhost:5173')

let mainWindow

const isFirebaseAuthPopup = (url) => {
  try {
    const destination = new URL(url)
    return (
      destination.protocol === 'https:' &&
      destination.pathname.startsWith('/__/auth/') &&
      (destination.hostname.endsWith('.firebaseapp.com') ||
        destination.hostname.endsWith('.web.app'))
    )
  } catch {
    return false
  }
}

const waitForUrl = async (url) => {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`The Antral UI did not start at ${url}.`)
}

const createWindow = async () => {
  const url = appUrl()
  const origin = new URL(url).origin

  if (isProd()) {
    // Launch the bundled backend; startServices waits for the gateway itself.
    await startServices(app.isPackaged)
  } else {
    await waitForUrl(url)
  }

  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 800,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!isFirebaseAuthPopup(target)) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      },
    }
  })
  mainWindow.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault()
  })
  mainWindow.webContents.on('did-create-window', (popup) => {
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    popup.webContents.on('will-navigate', (event, target) => {
      if (new URL(target).protocol !== 'https:') event.preventDefault()
    })
  })
  mainWindow.once('ready-to-show', () => mainWindow.show())
  await mainWindow.loadURL(url)
}

app.whenReady().then(async () => {
  try {
    await createWindow()
  } catch (error) {
    dialog.showErrorBox('Unable to launch Antral', error.message)
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((error) => {
      dialog.showErrorBox('Unable to launch Antral', error.message)
      app.quit()
    })
  }
})

// Stop the bundled services when the app closes.
app.on('before-quit', () => stopServices())
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
