/**
 * Host half of dsh-poke.
 *
 * The notice itself is drawn by the Client half; the Host owns the one thing a
 * browser cannot: the saved settings. They are declared as this plugin's
 * `Config` (edited on the plugin's own row in Plugins) and published to the page
 * on one loopback JSON route, so the Client can change its mind about cards
 * versus Windows notifications without being reloaded.
 *
 * Two small side routes keep the plugin diagnosable: `report` appends what the
 * page observed to `$DSH_HOME/dsh-poke/report.jsonl`, and `test` bumps a counter
 * the page reacts to, so the notice can be raised on demand instead of waiting
 * for a real task to finish.
 */

import { spawn } from 'node:child_process'
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Loader entry id; it also names the Client registration. */
export const name = 'dsh-poke'

/** Services this plugin's root fiber requires. */
export const inject = ['webServer']

/** The route the Client polls for the current settings. */
const SETTINGS_ROUTE = '/dsh-poke/config'
/** Raise one notice on every page that watches this counter. */
const TEST_ROUTE = '/dsh-poke/test'
/** Append one page observation to the diagnostics log. */
const REPORT_ROUTE = '/dsh-poke/report'
/** Raise one Windows toast on this machine. */
const TOAST_ROUTE = '/dsh-poke/toast'

/**
 * Windows toast shown through the Windows Runtime, from this Host process.
 * A renderer `Notification` is dropped by Electron when the app identity the
 * taskbar shortcut carries is not the one the toast is raised under, and that
 * failure is silent, so the toast is raised here instead. The payload and the
 * application identity travel in the environment so nothing needs shell quoting.
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
  includeCurrentSession: true,
  ignoreSubagents: true,
  windowsAppId: 'electron.app.DeepSeek Harness',
})

const MODES = ['auto', 'popup', 'notification']

/** Largest diagnostics log kept before it is restarted from empty. */
const REPORT_LIMIT_BYTES = 512 * 1024

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
  includeCurrentSession: z
    .boolean()
    .default(DEFAULTS.includeCurrentSession)
    .description('Also poke when the Session you are looking at finishes.'),
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
  const mode = MODES.includes(source.mode) ? source.mode : DEFAULTS.mode
  const number = (value, fallback, min) =>
    typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback
  return {
    mode,
    minDurationSeconds: number(source.minDurationSeconds, DEFAULTS.minDurationSeconds, 0),
    popupSeconds: number(source.popupSeconds, DEFAULTS.popupSeconds, 2),
    includeCurrentSession:
      typeof source.includeCurrentSession === 'boolean' ? source.includeCurrentSession : DEFAULTS.includeCurrentSession,
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
function readBody(req, limit = 64 * 1024) {
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
 * Publish this plugin's settings over one exact route, and keep the diagnostics
 * routes beside it.
 * @param ctx - the mounting Host context; `webServer` is required.
 * @param config - the validated row configuration.
 * @returns the disposer owned by the calling fiber.
 */
export function apply(ctx, config) {
  const settings = snapshotOf(config)
  const root = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'dsh-poke')
  const reportPath = join(root, 'report.jsonl')
  let testSeq = 0
  let reportBytes = 0

  const respond = (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }
    sendJson(res, { ...settings, testSeq }, req.method)
  }

  const test = (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    testSeq += 1
    sendJson(res, { testSeq }, req.method)
  }

  const report = async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' })
      res.end()
      return
    }
    const body = await readBody(req)
    try {
      await mkdir(root, { recursive: true })
      const line = `${JSON.stringify({ at: new Date().toISOString(), body })}\n`
      if (reportBytes === 0) {
        const size = await stat(reportPath).then((info) => info.size, () => 0)
        reportBytes = size
      }
      if (reportBytes + line.length > REPORT_LIMIT_BYTES) {
        await writeFile(reportPath, '')
        reportBytes = 0
      }
      await appendFile(reportPath, line)
      reportBytes += line.length
    } catch (error) {
      console.warn('[dsh-poke] the diagnostics line was not written:', error)
    }
    sendJson(res, { ok: true }, req.method)
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
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ shown: false, reason: 'bad-request' }))
      return
    }
    const title = typeof notice.title === 'string' && notice.title !== '' ? notice.title : 'Poke'
    const body = typeof notice.body === 'string' ? notice.body : ''
    const payload = Buffer.from(JSON.stringify({ title, body }), 'utf8').toString('base64')
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
        child.once('error', (error) => {
          console.warn('[dsh-poke] the toast process did not start:', error)
          resolve(false)
        })
        child.once('exit', (code) => resolve(code === 0))
        child.unref()
      } catch (error) {
        console.warn('[dsh-poke] the toast process threw:', error)
        resolve(false)
      }
    })
    sendJson(res, { shown }, req.method)
  }

  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: SETTINGS_ROUTE, handler: respond }),
    ctx.webServer.register({ kind: 'exact', path: TEST_ROUTE, handler: test }),
    ctx.webServer.register({ kind: 'exact', path: REPORT_ROUTE, handler: report }),
    ctx.webServer.register({ kind: 'exact', path: TOAST_ROUTE, handler: toast }),
  ]
  return ctx.effect(
    () => () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch (error) {
          console.warn('[dsh-poke] a route was not released:', error)
        }
      }
    },
    'dsh-poke: routes',
  )
}
