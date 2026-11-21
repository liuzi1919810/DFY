/**
 * Host half of dsh-poke.
 *
 * The notice is drawn by the Client half. The Host owns the saved settings and
 * the one thing a page cannot do: raise a real Windows toast, because Electron
 * drops a renderer `Notification` when the app identity the taskbar shortcut
 * carries is not the one the toast is raised under, and that failure is silent.
 */

import { spawn } from 'node:child_process'
import z from '@deepseek-ai/schemastery'

/** Loader entry id; it also names the Client registration. */
export const name = 'dsh-poke'

/** Services this plugin's root fiber requires. */
export const inject = ['webServer']

/** The page reads the current settings here. */
const SETTINGS_ROUTE = '/dsh-poke/config'
/** The page asks for one Windows toast here. */
const TOAST_ROUTE = '/dsh-poke/toast'

/**
 * Windows toast shown through the Windows Runtime, from this Host process.
 * The payload and the application identity travel in the environment, so no
 * value ever needs shell quoting.
 */
const TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:DSH_POKE_PAYLOAD))
$notice = $payload | ConvertFrom-Json
$title = [Security.SecurityElement]::Escape([string]$notice.title)
$body = ([Security.SecurityElement]::Escape([string]$notice.body)) -replace "\\r?\\n", ' · '
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast scenario="reminder"><visual><binding template="ToastGeneric"><text>' + $title + '</text><text>' + $body + '</text></binding></visual></toast>')
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:DSH_POKE_APP_ID).Show($toast)
`

/** Fallback values used when a row omits a field or carries an unusable one. */
const DEFAULTS = Object.freeze({
  mode: 'auto',
  minDurationSeconds: 5,
  popupSeconds: 8,
  ignoreSubagents: true,
  windowsAppId: 'electron.app.DeepSeek Harness',
})

const MODES = ['auto', 'popup', 'notification']

/** Settings surface rendered on the plugin's own row in Plugins. */
export const Config = z.object({
  mode: z
    .union(MODES)
    .default(DEFAULTS.mode)
    .description('auto: card while the window is in front, Windows notification otherwise. popup: card only. notification: Windows notification only.'),
  minDurationSeconds: z
    .number()
    .min(0)
    .step(1)
    .default(DEFAULTS.minDurationSeconds)
    .description('Only a task that ran at least this many seconds pokes you. 0 pokes for every finished task.'),
  popupSeconds: z
    .number()
    .min(2)
    .step(1)
    .default(DEFAULTS.popupSeconds)
    .description('How long the in-app card stays before it fades out.'),
  ignoreSubagents: z
    .boolean()
    .default(DEFAULTS.ignoreSubagents)
    .description('Skip subagent Sessions, so a parent task does not poke once per child.'),
  windowsAppId: z
    .string()
    .default(DEFAULTS.windowsAppId)
    .description('Windows application identity the toast is raised under. It must match the taskbar shortcut, otherwise Windows drops the toast silently.'),
})

/** The settings the page receives: every field present and inside its range. */
function snapshotOf(config) {
  const source = config ?? {}
  const number = (value, fallback, min) =>
    typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback
  return {
    mode: MODES.includes(source.mode) ? source.mode : DEFAULTS.mode,
    minDurationSeconds: number(source.minDurationSeconds, DEFAULTS.minDurationSeconds, 0),
    popupSeconds: number(source.popupSeconds, DEFAULTS.popupSeconds, 2),
    ignoreSubagents:
      typeof source.ignoreSubagents === 'boolean' ? source.ignoreSubagents : DEFAULTS.ignoreSubagents,
    windowsAppId:
      typeof source.windowsAppId === 'string' && source.windowsAppId !== ''
        ? source.windowsAppId
        : DEFAULTS.windowsAppId,
  }
}

/** Answer one JSON body, never caching it. */
function sendJson(res, value, method = 'GET') {
  const body = JSON.stringify(value)
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(method === 'HEAD' ? undefined : body)
}

/** Concatenate one request body, capped so a stuck page cannot grow it. */
function readBody(req, limit = 8 * 1024) {
  return new Promise((resolve) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      if (body.length < limit) body += chunk.slice(0, limit - body.length)
    })
    req.on('end', () => resolve(body))
    req.on('error', () => resolve(body))
  })
}

/**
 * Publish the settings and raise toasts for this profile.
 * @param ctx - the mounting Host context; `webServer` is required.
 * @param config - the validated row configuration.
 * @returns the disposer owned by the calling fiber.
 */
export function apply(ctx, config) {
  const settings = snapshotOf(config)

  const respond = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    sendJson(res, settings, req.method)
  }

  const toast = async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    let notice
    try {
      notice = JSON.parse(await readBody(req))
    } catch {
      sendJson(res, { shown: false }, req.method)
      return
    }
    const payload = Buffer.from(
      JSON.stringify({
        title: typeof notice.title === 'string' && notice.title !== '' ? notice.title : 'Poke',
        body: typeof notice.body === 'string' ? notice.body : '',
      }),
      'utf8',
    ).toString('base64')
    const shown = await new Promise((resolve) => {
      try {
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', TOAST_SCRIPT],
          {
            windowsHide: true,
            stdio: 'ignore',
            env: { ...process.env, DSH_POKE_PAYLOAD: payload, DSH_POKE_APP_ID: settings.windowsAppId },
          },
        )
        child.once('error', () => resolve(false))
        child.once('exit', (code) => resolve(code === 0))
        child.unref()
      } catch {
        resolve(false)
      }
    })
    sendJson(res, { shown }, req.method)
  }

  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: SETTINGS_ROUTE, handler: respond }),
    ctx.webServer.register({ kind: 'exact', path: TOAST_ROUTE, handler: toast }),
  ]
  return ctx.effect(
    () => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* Route release is best-effort during unload. */
        }
      }
    },
    'dsh-poke: routes',
  )
}
