/**
 * Client half of dsh-poke: a poke-style notice when a Session task finishes, or
 * when a Session is waiting for an answer.
 *
 * A task is over when the Session list reports a Session running and then not
 * running again. A Session is waiting when its pending interaction is a
 * question. Both raise the same notice: an in-app card on the frame-wide overlay
 * layer or a Windows toast, chosen by the settings the Host publishes. The card
 * is click-through outside itself and never raises the window, so the
 * application keeps its normal place behind other windows.
 *
 * The row's configuration page is drawn here too: DeepSeek Harness never
 * generates a plugin's form, it only reserves the seat and hands over the
 * values and the write action.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-poke',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** Locale namespace for every string this half shows. */
    const NAMESPACE = 'dsh-poke'
    /** Host route carrying the current settings. */
    const ENDPOINT = '/dsh-poke/config'
    /** Host route raising one Windows toast outside the page. */
    const TOAST_ENDPOINT = '/dsh-poke/toast'
    /** Settings used until the Host answers, and when it cannot be reached. */
    const DEFAULTS = Object.freeze({
      mode: 'auto',
      minDurationSeconds: 5,
      popupSeconds: 8,
      ignoreSubagents: true,
      windowsAppId: 'electron.app.DeepSeek Harness',
    })
    /** Fields the configuration page edits, in display order. */
    const FIELDS = ['mode', 'minDurationSeconds', 'popupSeconds', 'ignoreSubagents', 'windowsAppId']
    /** Most cards kept on screen at once; older ones fall off the top. */
    const MAX_CARDS = 3
    /** How often a mounted page re-reads the settings. */
    const REFRESH_MS = 15000

    const DICTS = {
      en: {
        'notify.title': 'Poke',
        'notice.finished': 'Task finished',
        'notice.question': 'Waiting for your answer',
        'action.open': 'Open this Session',
        'action.dismiss': 'Dismiss',
        'unit.hour': 'h',
        'unit.minute': 'min',
        'unit.second': 'sec',
        'config.summary': 'Notice channel, duration threshold, card lifetime, subagents, Windows identity',
        'config.loading': 'Loading…',
        'config.unavailable': 'Configuration is unavailable in this browser session',
        'config.readonly': 'This profile does not accept writes',
        'config.mode': 'Notice channel',
        'config.mode.auto': 'auto: card in front, Windows notification behind',
        'config.mode.popup': 'popup: card only',
        'config.mode.notification': 'notification: Windows notification only',
        'config.minDuration': 'Minimum duration (seconds)',
        'config.minDuration.hint': 'Only a task that ran at least this long pokes you. 0 pokes for every finished task.',
        'config.popupSeconds': 'Card lifetime (seconds)',
        'config.popupSeconds.hint': 'How long the card stays before it fades out.',
        'config.ignoreSubagents': 'Ignore subagent Sessions',
        'config.ignoreSubagents.hint': 'A parent task then pokes once instead of once per child.',
        'config.windowsAppId': 'Windows application identity',
        'config.windowsAppId.hint': 'Must match the taskbar shortcut, otherwise Windows drops the toast silently.',
        'config.save': 'Save',
        'config.saved': 'Saved',
        'config.failed': 'The Host refused the change',
        'config.saving': 'Saving…',
      },
      zh: {
        'notify.title': '戳一戳',
        'notice.finished': '跑完了',
        'notice.question': '等你回答',
        'action.open': '打开这个会话',
        'action.dismiss': '关闭',
        'unit.hour': '小时',
        'unit.minute': '分',
        'unit.second': '秒',
        'config.summary': '提醒方式、时长门槛、卡片停留、子智能体、Windows 标识',
        'config.loading': '加载中…',
        'config.unavailable': '当前浏览器会话里配置不可用',
        'config.readonly': '这个 profile 不接受写入',
        'config.mode': '提醒方式',
        'config.mode.auto': 'auto：前台弹卡片，后台发通知',
        'config.mode.popup': 'popup：只弹卡片',
        'config.mode.notification': 'notification：只发通知',
        'config.minDuration': '时长门槛（秒）',
        'config.minDuration.hint': '跑够这么久才提醒，0 表示每个任务都提醒',
        'config.popupSeconds': '卡片停留（秒）',
        'config.popupSeconds.hint': '卡片多久自动消失',
        'config.ignoreSubagents': '忽略子智能体',
        'config.ignoreSubagents.hint': '父会话结束时只戳一次，不按子任务重复',
        'config.windowsAppId': 'Windows 应用标识',
        'config.windowsAppId.hint': '必须和任务栏快捷方式一致，否则系统静默丢弃通知',
        'config.save': '保存',
        'config.saved': '已保存',
        'config.failed': '宿主拒绝了这次修改',
        'config.saving': '保存中…',
      },
    }

    const CSS = `
.dsh-poke-layer {
  position: fixed;
  top: var(--dsh-poke-top, 44px);
  right: 16px;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(360px, calc(100vw - 32px));
  pointer-events: none;
}
.dsh-poke-card {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 11px 12px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  cursor: pointer;
  animation: dsh-poke-in 0.22s ease-out;
  text-align: left;
}
.dsh-poke-card:hover {
  border-color: var(--dsw-alias-brand-primary);
}
.dsh-poke-card:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: 2px;
}
@keyframes dsh-poke-in {
  from { opacity: 0; transform: translateY(-8px) scale(0.98); }
  to { opacity: 1; transform: none; }
}
.dsh-poke-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  background: var(--dsw-alias-brand-primary);
}
.dsh-poke-dot[data-question='true'] {
  background: var(--dsw-alias-state-warn-primary);
}
.dsh-poke-body {
  flex: 1;
  min-width: 0;
}
.dsh-poke-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dsh-poke-meta {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--dsw-alias-label-secondary);
}
.dsh-poke-close {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.dsh-poke-close:hover {
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
}
.dsh-poke-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 680px;
}
.dsh-poke-field {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.dsh-poke-label {
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.dsh-poke-hint {
  margin-top: 3px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dsh-poke-input,
.dsh-poke-select {
  box-sizing: border-box;
  width: 100%;
  max-width: 320px;
  padding: 6px 9px;
  font: inherit;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
}
.dsh-poke-select {
  cursor: pointer;
}
.dsh-poke-check {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
}
.dsh-poke-check input {
  accent-color: var(--dsw-alias-brand-primary);
}
.dsh-poke-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.dsh-poke-save {
  padding: 6px 16px;
  font: inherit;
  font-size: 13px;
  color: var(--dsw-alias-bg-base);
  background: var(--dsw-alias-brand-primary);
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}
.dsh-poke-save:disabled {
  opacity: 0.5;
  cursor: default;
}
.dsh-poke-status {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
}
`

    /** Accept only the fields the Client understands, each inside its range. */
    function normalizeSettings(value) {
      if (value === null || typeof value !== 'object') return DEFAULTS
      const number = (input, fallback, min) =>
        typeof input === 'number' && Number.isFinite(input) && input >= min ? input : fallback
      return {
        mode: value.mode === 'popup' || value.mode === 'notification' ? value.mode : DEFAULTS.mode,
        minDurationSeconds: number(value.minDurationSeconds, DEFAULTS.minDurationSeconds, 0),
        popupSeconds: number(value.popupSeconds, DEFAULTS.popupSeconds, 2),
        ignoreSubagents:
          typeof value.ignoreSubagents === 'boolean' ? value.ignoreSubagents : DEFAULTS.ignoreSubagents,
        windowsAppId:
          typeof value.windowsAppId === 'string' && value.windowsAppId !== ''
            ? value.windowsAppId
            : DEFAULTS.windowsAppId,
      }
    }

    /**
     * Distance from the window top that clears the application's title bar.
     * The page fills the whole window and the title bar sits over its top edge,
     * so a card at 16px would be partly hidden under the window controls.
     * @returns the offset in CSS pixels.
     */
    function titleBarInset() {
      try {
        const overlay = navigator.windowControlsOverlay
        if (overlay !== undefined && overlay.visible === true && typeof overlay.getTitlebarAreaRect === 'function') {
          const rect = overlay.getTitlebarAreaRect()
          if (rect !== null && typeof rect === 'object' && rect.height > 0) return Math.round(rect.height) + 12
        }
      } catch {
        /* The overlay API is optional; fall through to the default. */
      }
      return 44
    }

    /** Human duration built from localized unit words, never from a template. */
    function formatDuration(t, milliseconds) {
      const total = Math.max(1, Math.round(milliseconds / 1000))
      if (total < 60) return `${total} ${t('unit.second')}`
      const minutes = Math.floor(total / 60)
      if (minutes < 60) {
        const seconds = total % 60
        const head = `${minutes} ${t('unit.minute')}`
        return seconds === 0 ? head : `${head} ${seconds} ${t('unit.second')}`
      }
      return `${Math.floor(minutes / 60)} ${t('unit.hour')} ${minutes % 60} ${t('unit.minute')}`
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const disposers = []
        const t = ctx.locale.bind(NAMESPACE)
        for (const locale of ['en', 'zh']) disposers.push(ctx.locale.register(NAMESPACE, locale, DICTS[locale]))

        /** Reveal one Session and put the application window in front. */
        const openSession = (sessionId) => {
          if (typeof sessionId !== 'string' || sessionId === '') return
          const uiWorkspace = ctx.get('uiWorkspace')
          if (uiWorkspace !== undefined) {
            try {
              uiWorkspace.openSession(sessionId)
            } catch (error) {
              console.warn('[dsh-poke] opening the Session failed:', error)
            }
          }
          try {
            window.focus()
          } catch {
            /* A browser may refuse the focus request; the Session still opened. */
          }
        }

        /**
         * Ask the Host to raise one Windows toast.
         * @returns whether the Host reported that it showed one.
         */
        const requestToast = (title, body) => {
          if (typeof fetch !== 'function') return Promise.resolve(false)
          return fetch(TOAST_ENDPOINT, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title, body }),
          })
            .then((response) => (response.ok ? response.json() : null))
            .then((value) => value !== null && value.shown === true)
            .catch(() => false)
        }

        /** One card or toast per finished task and per waiting question. */
        const Overlay = (props) => {
          const useSessions = props.useSessions
          const list = useSessions !== undefined ? useSessions((state) => state) : undefined
          const useSessionStatus = props.useSessionStatus
          const statuses = useSessionStatus !== undefined ? useSessionStatus((state) => state) : undefined
          const [cards, setCards] = useState([])
          const [top, setTop] = useState(44)
          const runningSince = useRef(new Map())
          /** Session id → the pending question key already noticed. */
          const questionsSeen = useRef(null)
          const settings = useRef(DEFAULTS)

          /** Drop one card by its key. */
          const dismiss = useCallback((key) => {
            setCards((previous) => previous.filter((card) => card.key !== key))
          }, [])

          /** Add one card, retiring the oldest beyond the cap. */
          const showCard = useCallback((item) => {
            const popupMs = settings.current.popupSeconds * 1000
            setCards((previous) =>
              [
                ...previous,
                {
                  key: `${item.sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
                  sessionId: item.sessionId,
                  title: item.title,
                  detail: item.detail,
                  question: item.question === true,
                  expiresAt: Date.now() + popupMs,
                },
              ].slice(-MAX_CARDS),
            )
          }, [])

          /** Notice one finished task or waiting question, through the chosen channel. */
          const raise = useCallback(
            (item) => {
              const config = settings.current
              const inFront =
                typeof document !== 'undefined'
                && document.visibilityState === 'visible'
                && document.hasFocus()
              const channel =
                config.mode === 'popup'
                  ? 'popup'
                  : config.mode === 'notification'
                    ? 'notification'
                    : inFront
                      ? 'popup'
                      : 'notification'
              if (channel === 'popup') {
                showCard(item)
                return
              }
              void requestToast(t('notify.title'), `${item.title}\n${item.detail}`).then((shown) => {
                if (!shown) showCard(item)
              })
            },
            [showCard],
          )

          // The card row sits under the application title bar, never under it.
          useEffect(() => {
            setTop(titleBarInset())
          }, [])

          // Settings refresh: on mount, when the page returns to the front, and
          // once in a while, so an edited configuration reaches a mounted page.
          useEffect(() => {
            let alive = true
            const load = () => {
              if (typeof fetch !== 'function') return
              fetch(ENDPOINT, { cache: 'no-store' })
                .then((response) => (response.ok ? response.json() : null))
                .then((value) => {
                  if (alive && value !== null) settings.current = normalizeSettings(value)
                })
                .catch(() => {
                  /* The route is absent while the Host half is off; defaults stay. */
                })
            }
            load()
            const timer = setInterval(load, REFRESH_MS)
            document.addEventListener('visibilitychange', load)
            return () => {
              alive = false
              clearInterval(timer)
              document.removeEventListener('visibilitychange', load)
            }
          }, [])

          // Card expiry. Only cards the user can already see run this timer.
          useEffect(() => {
            if (cards.length === 0) return undefined
            const timer = setInterval(() => {
              const now = Date.now()
              setCards((previous) => previous.filter((card) => card.expiresAt > now))
            }, 400)
            return () => clearInterval(timer)
          }, [cards.length])

          // Running-state watch: remember when a Session started and notice when
          // it stops again, which is what "the task is over" means here.
          useEffect(() => {
            if (list === undefined || list.byId === undefined) return
            const config = settings.current
            const now = Date.now()
            const started = runningSince.current
            for (const sessionId of list.ids) {
              const row = list.byId[sessionId]
              if (row === undefined || row.blank === true) continue
              if (config.ignoreSubagents && row.origin === 'subagent') continue
              const previous = started.get(sessionId)
              if (row.running === true) {
                if (previous === undefined) started.set(sessionId, { since: now, title: row.displayTitle })
                else if (row.displayTitle !== undefined) previous.title = row.displayTitle
                continue
              }
              if (previous === undefined) continue
              started.delete(sessionId)
              const duration = now - previous.since
              if (duration < config.minDurationSeconds * 1000) continue
              raise({
                sessionId,
                title: previous.title || row.displayTitle || sessionId,
                detail: `${t('notice.finished')} · ${formatDuration(t, duration)}`,
              })
            }
          }, [list, raise, t])

          // Pending-question watch: a Session that starts waiting for an answer
          // pokes once per question. The first snapshot only records what is
          // already pending, so opening the page mid-question stays quiet.
          useEffect(() => {
            if (statuses === undefined) return
            const previous = questionsSeen.current
            const next = new Map()
            for (const [sessionId, status] of statuses) {
              const interaction = status.pendingInteraction
              const key = interaction !== undefined && interaction.kind === 'question' ? interaction.key : undefined
              next.set(sessionId, key)
            }
            questionsSeen.current = next
            if (previous === null) return
            const config = settings.current
            for (const [sessionId, key] of next) {
              if (key === undefined || previous.get(sessionId) === key) continue
              const row = list === undefined || list.byId === undefined ? undefined : list.byId[sessionId]
              if (row === undefined || row.blank === true) continue
              if (config.ignoreSubagents && row.origin === 'subagent') continue
              raise({
                sessionId,
                title: row.displayTitle || sessionId,
                detail: t('notice.question'),
                question: true,
              })
            }
          }, [statuses, list, raise, t])

          return h(
            'div',
            { className: 'dsh-poke-layer', style: { '--dsh-poke-top': `${top}px` }, 'aria-live': 'polite' },
            h('style', { key: 'dsh-poke-style' }, CSS),
            cards.map((card) =>
              h(
                'div',
                {
                  key: card.key,
                  className: 'dsh-poke-card',
                  role: 'status',
                  tabIndex: 0,
                  title: t('action.open'),
                  onClick: () => {
                    openSession(card.sessionId)
                    dismiss(card.key)
                  },
                  onKeyDown: (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    openSession(card.sessionId)
                    dismiss(card.key)
                  },
                },
                h('span', {
                  className: 'dsh-poke-dot',
                  'data-question': card.question ? 'true' : undefined,
                  'aria-hidden': true,
                }),
                h(
                  'div',
                  { className: 'dsh-poke-body' },
                  h('div', { className: 'dsh-poke-title' }, card.title),
                  h('div', { className: 'dsh-poke-meta' }, card.detail),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-poke-close',
                    'aria-label': t('action.dismiss'),
                    onClick: (event) => {
                      event.stopPropagation()
                      dismiss(card.key)
                    },
                  },
                  '\u00d7',
                ),
              ),
            ),
          )
        }

        /**
         * The row's configuration page.
         * @param props - the page's view request and the Host-owned form.
         */
        const SettingsForm = (props) => {
          const form = props.form
          const snapshot = form === undefined ? undefined : form.state
          const values = snapshot === undefined ? undefined : snapshot.value
          const revision = snapshot === undefined ? undefined : snapshot.revision
          const [draft, setDraft] = useState(null)
          const [phase, setPhase] = useState('idle')
          /** Revision already copied into the draft; guards against re-seeding. */
          const seeded = useRef(-1)

          // Seed the draft from the Host values, and again after any accepted
          // write: the page republishes the snapshot with a new revision.
          useEffect(() => {
            if (values === undefined || values === null) return
            if (seeded.current === revision) return
            seeded.current = revision
            setDraft({
              mode: values.mode === 'popup' || values.mode === 'notification' ? values.mode : DEFAULTS.mode,
              minDurationSeconds:
                typeof values.minDurationSeconds === 'number' ? values.minDurationSeconds : DEFAULTS.minDurationSeconds,
              popupSeconds: typeof values.popupSeconds === 'number' ? values.popupSeconds : DEFAULTS.popupSeconds,
              ignoreSubagents:
                typeof values.ignoreSubagents === 'boolean' ? values.ignoreSubagents : DEFAULTS.ignoreSubagents,
              windowsAppId:
                typeof values.windowsAppId === 'string' && values.windowsAppId !== ''
                  ? values.windowsAppId
                  : DEFAULTS.windowsAppId,
            })
            setPhase('idle')
          }, [revision, values])

          if (props.view === 'summary') return t('config.summary')
          if (form === undefined || snapshot === undefined || draft === null) {
            return h('div', { className: 'dsh-poke-status' }, t('config.loading'))
          }
          if (snapshot.status === 'unavailable') {
            return h('div', { className: 'dsh-poke-status' }, t('config.unavailable'))
          }

          /** Write the fields that differ from the Host values. */
          const save = () => {
            const ops = []
            for (const field of FIELDS) {
              const next = draft[field]
              if (next === values[field]) continue
              if (field === 'windowsAppId' && next === DEFAULTS.windowsAppId) {
                ops.push({ op: 'unset', path: [field] })
              } else if (typeof next === 'string' && next === '') {
                ops.push({ op: 'unset', path: [field] })
              } else {
                ops.push({ op: 'set', path: [field], value: next })
              }
            }
            if (ops.length === 0) {
              setPhase('saved')
              return
            }
            setPhase('saving')
            form.mutate(ops, revision).then(
              (accepted) => setPhase(accepted ? 'saved' : 'failed'),
              () => setPhase('failed'),
            )
          }

          const editable = snapshot.writable === true && phase !== 'saving'

          const field = (label, hint, control) =>
            h(
              'div',
              { className: 'dsh-poke-field' },
              h(
                'div',
                null,
                h('div', { className: 'dsh-poke-label' }, label),
                hint === undefined ? null : h('div', { className: 'dsh-poke-hint' }, hint),
              ),
              h('div', null, control),
            )

          const numberInput = (name) =>
            h('input', {
              className: 'dsh-poke-input',
              type: 'number',
              min: 0,
              step: 1,
              value: String(draft[name]),
              disabled: !editable,
              onChange: (event) => {
                const parsed = Number(event.target.value)
                setDraft((current) => ({ ...current, [name]: Number.isFinite(parsed) ? parsed : 0 }))
                setPhase('idle')
              },
            })

          return h(
            'div',
            { className: 'dsh-poke-form' },
            h('style', { key: 'dsh-poke-form-style' }, CSS),
            field(
              t('config.mode'),
              undefined,
              h(
                'select',
                {
                  className: 'dsh-poke-select',
                  value: draft.mode,
                  disabled: !editable,
                  onChange: (event) => {
                    setDraft((current) => ({ ...current, mode: event.target.value }))
                    setPhase('idle')
                  },
                },
                h('option', { value: 'auto' }, t('config.mode.auto')),
                h('option', { value: 'popup' }, t('config.mode.popup')),
                h('option', { value: 'notification' }, t('config.mode.notification')),
              ),
            ),
            field(t('config.minDuration'), t('config.minDuration.hint'), numberInput('minDurationSeconds')),
            field(t('config.popupSeconds'), t('config.popupSeconds.hint'), numberInput('popupSeconds')),
            field(
              t('config.ignoreSubagents'),
              t('config.ignoreSubagents.hint'),
              h(
                'label',
                { className: 'dsh-poke-check' },
                h('input', {
                  type: 'checkbox',
                  checked: draft.ignoreSubagents === true,
                  disabled: !editable,
                  onChange: (event) => {
                    setDraft((current) => ({ ...current, ignoreSubagents: event.target.checked }))
                    setPhase('idle')
                  },
                }),
              ),
            ),
            field(
              t('config.windowsAppId'),
              t('config.windowsAppId.hint'),
              h('input', {
                className: 'dsh-poke-input',
                type: 'text',
                value: draft.windowsAppId,
                disabled: !editable,
                onChange: (event) => {
                  setDraft((current) => ({ ...current, windowsAppId: event.target.value }))
                  setPhase('idle')
                },
              }),
            ),
            h(
              'div',
              { className: 'dsh-poke-actions' },
              h(
                'button',
                { type: 'button', className: 'dsh-poke-save', disabled: !editable, onClick: save },
                t('config.save'),
              ),
              h(
                'span',
                { className: 'dsh-poke-status', role: 'status' },
                snapshot.writable !== true
                  ? t('config.readonly')
                  : phase === 'saving'
                    ? t('config.saving')
                    : phase === 'saved'
                      ? t('config.saved')
                      : phase === 'failed'
                        ? t('config.failed')
                        : '',
              ),
            ),
          )
        }

        disposers.push(
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register({ name: 'shell.overlay', id: 'dsh-poke', order: 60 }, Overlay),
          ),
          ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register(
              { name: 'plugins.row.config', key: '@local/dsh-poke#dsh-poke', locale: NAMESPACE },
              SettingsForm,
            ),
          ),
        )
        return () => {
          for (const dispose of disposers) {
            try {
              dispose()
            } catch {
              /* Registration teardown is best-effort during unload. */
            }
          }
        }
      },
    }
  },
})
