/**
 * Client half of dsh-poke: a poke-style notice when a Session task finishes.
 *
 * A task is over when the Session list reports a Session running and then not
 * running again. The notice is an in-app card on the frame-wide overlay layer or
 * a Windows toast, chosen by the settings the Host publishes; the card is
 * click-through outside itself and never raises the window, so the application
 * keeps its normal place behind other windows.
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
    })
    /** Most cards kept on screen at once; older ones fall off the top. */
    const MAX_CARDS = 3
    /** How often a mounted page re-reads the settings. */
    const REFRESH_MS = 15000

    const DICTS = {
      en: {
        'notify.title': 'Poke',
        'notice.finished': 'Task finished',
        'action.open': 'Open this Session',
        'action.dismiss': 'Dismiss',
        'unit.hour': 'h',
        'unit.minute': 'min',
        'unit.second': 'sec',
      },
      zh: {
        'notify.title': '戳一戳',
        'notice.finished': '跑完了',
        'action.open': '打开这个会话',
        'action.dismiss': '关闭',
        'unit.hour': '小时',
        'unit.minute': '分',
        'unit.second': '秒',
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

        const Overlay = (props) => {
          const useSessions = props.useSessions
          const list = useSessions !== undefined ? useSessions((state) => state) : undefined
          const [cards, setCards] = useState([])
          const [top, setTop] = useState(44)
          const runningSince = useRef(new Map())
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
                  duration: item.duration,
                  expiresAt: Date.now() + popupMs,
                },
              ].slice(-MAX_CARDS),
            )
          }, [])

          /** Notice one finished task, through the channel the settings choose. */
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
              void requestToast(
                t('notify.title'),
                `${item.title}\n${t('notice.finished')} · ${formatDuration(t, item.duration)}`,
              ).then((shown) => {
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
                duration,
              })
            }
          }, [list, raise])

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
                h('span', { className: 'dsh-poke-dot', 'aria-hidden': true }),
                h(
                  'div',
                  { className: 'dsh-poke-body' },
                  h('div', { className: 'dsh-poke-title' }, card.title),
                  h('div', { className: 'dsh-poke-meta' }, `${t('notice.finished')} · ${formatDuration(t, card.duration)}`),
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

        disposers.push(
          ctx.slots.inject('shell.overlay', () =>
            ctx.slots.register({ name: 'shell.overlay', id: 'dsh-poke', order: 60 }, Overlay),
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
