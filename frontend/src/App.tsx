import { useCallback, useEffect, useRef, useState } from 'react'
import {
  approveDecision, ask, AskRejected, createRun, errorText, getChips, getEvents, getHealth, getRun, rejectDecision,
  type Loaded,
} from './api/client'
import type { Answer, Chip, Decision, Engine, Run } from './api/types'
import { ENGINE_COLOR, ENGINE_NAME } from './lib/format'
import { useLoad } from './lib/useLoad'
import { Stage } from './components/Stage'
import { Dock } from './components/Dock'
import { CompareSheet } from './components/CompareSheet'
import { Drawer, type Tab } from './components/Drawer'
import { StoryCaption, useStoryPlayer } from './components/Story'

const ME_KEY = 'pg.requested_by'
const VIEW_KEY = 'pg.view'
const readView = (): '2d' | '3d' => { try { return localStorage.getItem(VIEW_KEY) === '3d' ? '3d' : '2d' } catch { return '2d' } }
const readMe = () => { try { return localStorage.getItem(ME_KEY) || 'Kevin' } catch { return 'Kevin' } }

export default function App() {
  // ---- company, event ----------------------------------------------------------------------
  const health = useLoad(() => getHealth(), [])
  const tenants = health.value?.data.tenants ?? []
  const companies = health.value?.data.companies ?? tenants.filter(t => t !== 'bench' && !/^(pytest|test)/.test(t))
  const [tenant, setTenant] = useState('northwind')
  useEffect(() => {
    if (companies.length && !companies.includes(tenant)) setTenant(companies[0])
  }, [companies, tenant])

  const events = useLoad(() => getEvents(tenant), [tenant])
  const today = new Date().toISOString().slice(0, 10)
  const event = events.value?.data.find(e => e.end >= today) ?? events.value?.data[0] ?? null

  // ---- asking ------------------------------------------------------------------------------
  const [engine, setEngine] = useState<Engine>('falkordb')
  const chips = useLoad(() => getChips(tenant), [tenant])
  const [question, setQuestion] = useState<string | null>(null)
  const [answer, setAnswer] = useState<Loaded<Answer> | null>(null)
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  const [rejected, setRejected] = useState<{ detail: string; suggestions: Chip[] } | null>(null)
  const askCtl = useRef<AbortController | null>(null)

  const run = useCallback(async (q: string, eng: Engine, t: string) => {
    askCtl.current?.abort()
    const ctl = new AbortController()
    askCtl.current = ctl
    setAsking(true); setAskError(null); setRejected(null); setQuestion(q)
    try {
      const res = await ask(t, q, eng, ctl.signal)
      if (ctl.signal.aborted) return
      // Same graph as before (e.g. only the engine changed)? Keep the old object so the 3D
      // layout and camera stay put.
      setAnswer(prev => (prev && JSON.stringify(prev.data.graph) === JSON.stringify(res.data.graph)
        ? { ...res, data: { ...res.data, graph: prev.data.graph } } : res))
    } catch (e) {
      if (ctl.signal.aborted) return
      if (e instanceof AskRejected) setRejected({ detail: e.message, suggestions: e.suggestions })
      else setAskError(errorText(e) || null)
    } finally {
      if (!ctl.signal.aborted) setAsking(false)
    }
  }, [])
  const onAsk = useCallback((q: string) => run(q, engine, tenant), [run, engine, tenant])

  // New company: start over with its first suggestion.
  useEffect(() => { setAnswer(null); setQuestion(null); setRejected(null); setAskError(null) }, [tenant])
  const firstChip = chips.value?.data[0]?.question
  useEffect(() => {
    if (!question && !answer && firstChip) run(firstChip, engine, tenant)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstChip, tenant])

  // The engine switch changes which database answers: ask the current question again.
  const switchEngine = (e: Engine) => {
    if (e === engine) return
    setEngine(e)
    if (question) run(question, e, tenant)
  }

  // ---- compare, drawer -----------------------------------------------------------------------
  const [view, setView] = useState(readView)
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view) } catch { /* private mode */ } }, [view])
  const [comparing, setComparing] = useState(false)
  const [tab, setTab] = useState<Tab | null>(null)
  const toggleTab = (t: Tab) => setTab(cur => (cur === t ? null : t))

  // ---- agents (shared by the Agents tab and the story) ----------------------------------------
  const [me, setMe] = useState(readMe)
  useEffect(() => { try { localStorage.setItem(ME_KEY, me) } catch { /* private mode */ } }, [me])
  const [agentRun, setAgentRun] = useState<Loaded<Run> | null>(null)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  useEffect(() => { setAgentRun(null); setRunError(null) }, [tenant])

  // Gemini rewrites each explanation in the background (~5-10 s): re-read the run every 2 s
  // until none is still a template, or ~16 s pass. A newer poll cancels an older one.
  const pollToken = useRef(0)
  const followUp = useCallback((res: Loaded<Run>) => {
    const token = ++pollToken.current
    const pending = (r: Run) => r.decisions.some(d => (d as Decision & { explanation_source?: string }).explanation_source === 'template')
    if (!pending(res.data)) return
    let left = 8
    const tick = () => window.setTimeout(async () => {
      if (token !== pollToken.current || left-- <= 0) return
      try {
        const next = await getRun(tenant, res.data.id)
        if (token !== pollToken.current) return
        setAgentRun(next)
        if (pending(next.data)) tick()
      } catch { /* run reset or API down: stop quietly */ }
    }, 2000)
    tick()
  }, [tenant])
  const acceptRun = useCallback((res: Loaded<Run>) => { setAgentRun(res); followUp(res) }, [followUp])

  const startAgents = useCallback(async () => {
    if (!event || running) return
    pollToken.current++
    setRunning(true); setRunError(null)
    try { acceptRun(await createRun(tenant, event.id, me.trim() || 'anonymous')) } catch (e) { setRunError(errorText(e)) } finally { setRunning(false) }
  }, [event, running, tenant, me, acceptRun])

  const decide = useCallback(async (d: Decision, by: string, approve: boolean) => {
    if (!agentRun) return
    const res = await (approve ? approveDecision : rejectDecision)(tenant, agentRun.data, d, by)
    acceptRun(res)
  }, [agentRun, tenant, acceptRun])

  // ---- story ---------------------------------------------------------------------------------
  const story = useStoryPlayer(tenant, event?.id ?? null, acceptRun)
  const playing = !!story.view
  const startStory = () => { setTab(null); setComparing(false); story.play() }

  const a = answer?.data
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden />Promise Graph</div>
        {companies.length > 1 ? (
          <label className="company">
            <span>Company</span>
            <select className="select" value={tenant} onChange={e => setTenant(e.target.value)} disabled={playing}>
              {companies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        ) : <span className="company" style={{ textTransform: 'capitalize' }}>{tenant}</span>}

        <div className="engine-switch" role="radiogroup" aria-label="Database that answers">
          {(['falkordb', 'postgres'] as Engine[]).map(e => (
            <button key={e} role="radio" aria-checked={engine === e} className={engine === e ? 'on' : ''}
              onClick={() => switchEngine(e)} disabled={playing}>
              <i className="dot" style={{ background: ENGINE_COLOR[e] }} />{ENGINE_NAME[e]}
            </button>
          ))}
        </div>
        <button className="btn" onClick={() => setComparing(true)} disabled={!question || playing}>Compare</button>

        <span className="spacer" />
        <nav className="nav">
          {(['agents', 'memory', 'benchmark'] as Tab[]).map(t => (
            <button key={t} className={`btn btn-quiet${tab === t ? ' on' : ''}`} onClick={() => toggleTab(t)} disabled={playing}>
              {t === 'agents' ? 'Agents' : t === 'memory' ? 'Memory' : 'Benchmark'}
            </button>
          ))}
        </nav>
        <button className="btn btn-dark" onClick={playing ? story.stop : startStory} disabled={!event || story.loading}>
          {story.loading ? <span className="spinner" /> : playing ? '■' : '▶'} {playing ? 'Stop story' : 'Play the story'}
        </button>
      </header>

      <Stage
        graph={story.view?.graph ?? a?.graph ?? null}
        loading={asking || chips.loading}
        title={a?.title}
        note={a?.graph.note ?? (a?.graph.truncated ? 'Showing part of the answer.' : undefined)}
        reveal={story.view?.reveal ?? null}
        focus={story.view?.focus ?? null}
        flyKey={story.view?.flyKey ?? 0}
        story={playing}
        view={view}
        onView={setView}
      >
        {story.view && <StoryCaption view={story.view} onSkip={story.stop} />}
        {story.error && !playing && (
          <div className="story-caption"><div className="notice err">The story could not start: {story.error}</div></div>
        )}
      </Stage>

      <Dock
        answer={answer} asking={asking} question={question} engine={engine} error={askError} rejected={rejected}
        chips={chips.value?.data ?? []} dim={playing} onAsk={onAsk}
      />

      {comparing && question && <CompareSheet tenant={tenant} question={question} onClose={() => setComparing(false)} />}
      {tab && !playing && (
        <Drawer
          tab={tab} onTab={setTab} onClose={() => setTab(null)}
          tenant={tenant} tenants={tenants} engine={engine} event={event}
          run={agentRun} running={running} runError={runError}
          me={me} onMe={setMe} onRun={startAgents} onDecide={decide}
        />
      )}
    </div>
  )
}
