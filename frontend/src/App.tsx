import { useCallback, useEffect, useRef, useState } from 'react'
import {
  approveDecision, ask, AskRejected, createRun, errorText, getChips, getClusters, getEvents, getHealth, getInfluence,
  getRecall, getRun, rejectDecision, streamRun, type Loaded,
} from './api/client'
import type { AgentName, Answer, Chip, Decision, Engine, MemoryInfluence, Run } from './api/types'
import { ENGINE_NAME } from './lib/format'
import { TERMS } from './lib/glossary'
import { usePrefersReducedMotion } from './lib/motion'
import { useLoad } from './lib/useLoad'
import { AskDock } from './components/AskDock'
import { CompareSheet } from './components/CompareSheet'
import { Drawer, type Tab } from './components/Drawer'
import { GraphStage } from './components/GraphStage'
import { MemoryCompare } from './components/MemoryCompare'
import { ResponsePanel, type Phase } from './components/Response'
import { StoryCaption, useStoryPlayer } from './components/Story'
import { TechExplain } from './components/TechExplain'
import { Tip } from './components/Term'
import { WhatHappened } from './components/WhatHappened'

const ME_KEY = 'pg.requested_by'
const VIEW_KEY = 'pg.view'
const HINT_KEY = 'pg.hint.seen'
const store = {
  get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } },
}

export default function App() {
  const reduced = usePrefersReducedMotion()

  // ---- company and disruption ----------------------------------------------------------------
  const health = useLoad(() => getHealth(), [])
  const tenants = health.value?.data.tenants ?? []
  const companies = health.value?.data.companies ?? tenants.filter(t => t !== 'bench' && !/^(pytest|test)/.test(t))
  const [tenant, setTenant] = useState('northwind')
  useEffect(() => {
    if (companies.length && !companies.includes(tenant)) setTenant(companies[0])
  }, [companies, tenant])

  const events = useLoad(() => getEvents(tenant), [tenant])
  const evList = events.value?.data ?? []
  const [eventId, setEventId] = useState<string | null>(null)
  const today = new Date().toISOString().slice(0, 10)
  const event = evList.find(e => e.id === eventId) ?? evList.find(e => e.end >= today) ?? evList[0] ?? null
  const clusters = useLoad(() => (event ? getClusters(tenant, event.id) : null), [tenant, event?.id])
  const onFile = useLoad(() => (event ? getRecall(tenant, event.id) : null), [tenant, event?.id])
  const chips = useLoad(() => (event ? getChips(tenant, event.id) : null), [tenant, event?.id])

  // ---- asking the graph ------------------------------------------------------------------------
  const [engine, setEngine] = useState<Engine>('falkordb')
  const [question, setQuestion] = useState<string | null>(null)
  const [answer, setAnswer] = useState<Loaded<Answer> | null>(null)
  const [asking, setAsking] = useState(false)
  const [askError, setAskError] = useState<string | null>(null)
  const [rejected, setRejected] = useState<{ detail: string; suggestions: Chip[] } | null>(null)
  const askCtl = useRef<AbortController | null>(null)

  const runAsk = useCallback(async (q: string, eng: Engine, t: string) => {
    askCtl.current?.abort()
    const ctl = new AbortController()
    askCtl.current = ctl
    setAsking(true); setAskError(null); setRejected(null); setQuestion(q)
    try {
      const res = await ask(t, q, eng, ctl.signal)
      if (ctl.signal.aborted) return
      // Same graph as before (only the engine changed)? Keep the old object so nothing replays.
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
  const onAsk = useCallback((q: string) => runAsk(q, engine, tenant), [runAsk, engine, tenant])
  const switchEngine = (e: Engine) => {
    if (e === engine) return
    setEngine(e)
    if (question) runAsk(question, e, tenant)
  }

  // ---- the agents' run (live) ----------------------------------------------------------------
  const [me, setMe] = useState(() => store.get(ME_KEY) || 'Kevin Sudhan')
  useEffect(() => { store.set(ME_KEY, me) }, [me])
  const [run, setRun] = useState<Run | null>(null)
  const [phases, setPhases] = useState<Partial<Record<AgentName, Phase>>>({})
  const [running, setRunning] = useState(false)
  const [approving, setApproving] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [influence, setInfluence] = useState<MemoryInfluence | null>(null)
  const stopStream = useRef<(() => void) | null>(null)
  const runToken = useRef(0)

  const loadInfluence = useCallback(async (r: Run) => {
    const my = runToken.current
    if (r.memory === 'off' || r.status === 'running' || r.status === 'failed') return
    try {
      const res = await getInfluence(tenant, r.id)
      if (my === runToken.current) setInfluence(res.data)
    } catch { /* the card keeps saying it is checking; the run is unaffected */ }
  }, [tenant])

  // Gemini may reword explanations a few seconds after a run: re-read it for ~16 s (numbers never change).
  const followUp = useCallback((r: Run) => {
    const my = runToken.current
    const pending = (x: Run) => x.decisions.some(d => (d as Decision & { explanation_source?: string }).explanation_source === 'template')
    if (!pending(r)) return
    let left = 8
    const tick = () => window.setTimeout(async () => {
      if (my !== runToken.current || left-- <= 0) return
      try {
        const next = await getRun(tenant, r.id)
        if (my !== runToken.current) return
        setRun(next.data)
        if (pending(next.data)) tick()
      } catch { /* run reset or API down: stop quietly */ }
    }, 2000)
    tick()
  }, [tenant])

  const resetRun = useCallback(() => {
    runToken.current++
    stopStream.current?.(); stopStream.current = null
    setRun(null); setPhases({}); setRunning(false); setRunError(null); setInfluence(null)
  }, [])

  const acceptRun = useCallback((res: Loaded<Run>) => {   // a finished run from elsewhere (the story)
    runToken.current++
    stopStream.current?.(); stopStream.current = null
    setRun(res.data); setPhases({}); setRunError(null); setInfluence(null)
    loadInfluence(res.data); followUp(res.data)
  }, [loadInfluence, followUp])

  const runAgents = useCallback(async () => {
    if (!event || running) return
    resetRun()
    const my = runToken.current
    setRunning(true)
    try {
      const res = await createRun(tenant, event.id, me.trim() || 'anonymous', { live: true })
      if (my !== runToken.current) return
      setRun(res.data)
      stopStream.current = streamRun(tenant, res.data.id, ev => {
        if (my !== runToken.current) return
        setRun(ev.run)
        if (ev.type === 'step' && ev.agent && ev.phase) setPhases(p => ({ ...p, [ev.agent!]: ev.phase! }))
        if (ev.type === 'end') {
          setRunning(false)
          if (ev.status === 'failed') setRunError('The agents stopped: one step failed. See the timeline.')
          loadInfluence(ev.run); followUp(ev.run)
        }
      }, msg => { if (my === runToken.current) { setRunning(false); setRunError(msg) } })
    } catch (e) {
      if (my === runToken.current) { setRunning(false); setRunError(errorText(e)) }
    }
  }, [event, running, resetRun, tenant, me, loadInfluence, followUp])

  const decide = useCallback(async (d: Decision, by: string, approve: boolean) => {
    if (!run) return
    setApproving(approve)
    try {
      const res = await (approve ? approveDecision : rejectDecision)(tenant, run, d, by)
      setRun(res.data); followUp(res.data)
    } finally {
      setApproving(false)
    }
  }, [run, tenant, followUp])

  // ---- new company or disruption: back to the landing state ----------------------------------
  useEffect(() => { setEventId(null) }, [tenant])
  useEffect(() => {
    askCtl.current?.abort()
    setAnswer(null); setQuestion(null); setRejected(null); setAskError(null); setAsking(false)
    resetRun()
  }, [tenant, event?.id, resetRun])
  useEffect(() => () => stopStream.current?.(), [])

  // ---- view, drawers, sheets -------------------------------------------------------------------
  const [view, setView] = useState<'2d' | '3d'>(() => (store.get(VIEW_KEY) === '3d' ? '3d' : '2d'))
  useEffect(() => { store.set(VIEW_KEY, view) }, [view])
  const [comparingEngines, setComparingEngines] = useState(false)
  const [comparingMemory, setComparingMemory] = useState(false)
  const [tab, setTab] = useState<Tab | null>(null)
  const toggleTab = (t: Tab) => setTab(cur => (cur === t ? null : t))
  const [hint, setHint] = useState(() => store.get(HINT_KEY) !== '1')
  const dismissHint = () => { setHint(false); store.set(HINT_KEY, '1') }

  // ---- story -----------------------------------------------------------------------------------
  const story = useStoryPlayer(tenant, event?.id ?? null, acceptRun)
  const playing = !!story.view
  const startStory = () => { setTab(null); setComparingEngines(false); setComparingMemory(false); story.play() }

  const a = answer?.data
  const answering = playing || asking || !!answer || !!rejected || !!askError
  const animKey = playing ? `story:${event?.id}` : a ? `${tenant}:${a.template}:${a.read_as}` : 'none'

  return (
    <div className="app">
      <div className="ambient" aria-hidden><i /><i /><i /></div>
      <header className="topbar">
        <div className="brand"><span className="brand-mark" aria-hidden />Promise Graph</div>
        {companies.length > 1 ? (
          <label className="company">
            <span>Company</span>
            <select className="select" value={tenant} onChange={e => setTenant(e.target.value)} disabled={playing || running}>
              {companies.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        ) : <span className="company" style={{ textTransform: 'capitalize' }}>{tenant}</span>}
        <span className="spacer" />
        <Tip tip={TERMS.engine} below>
          <div className="segmented" role="radiogroup" aria-label="Database that answers your questions">
            {(['falkordb', 'postgres'] as Engine[]).map(e => (
              <button key={e} role="radio" aria-checked={engine === e} className={engine === e ? 'on' : ''}
                onClick={() => switchEngine(e)} disabled={playing}>
                {ENGINE_NAME[e]}{e === 'falkordb' && <span className="primary-tag">Primary</span>}
              </button>
            ))}
          </div>
        </Tip>
        <nav className="nav" aria-label="Benchmark and memory">
          <button className={`btn btn-sm btn-quiet${tab === 'benchmark' ? ' on' : ''}`} onClick={() => toggleTab('benchmark')} disabled={playing}>Benchmark</button>
          <button className={`btn btn-sm btn-quiet${tab === 'memory' ? ' on' : ''}`} onClick={() => toggleTab('memory')} disabled={playing}>Memory</button>
        </nav>
        <button className="btn btn-sm" onClick={playing ? story.stop : startStory} disabled={!event || story.loading || running}>
          {story.loading ? <span className="spinner" /> : playing ? '■' : '▶'} {playing ? 'Stop story' : 'Play the 30-second story'}
        </button>
      </header>

      <div className="workspace">
        <main className={`main${answering ? ' answering' : ''}${playing ? ' story' : ''}`}>
          <WhatHappened
            compact={answering} events={evList} event={event} onEvent={id => setEventId(id)}
            clusters={clusters.value?.data ?? null} loading={clusters.loading || events.loading} disabled={playing || running} reduced={reduced}
          />
          {answering && (
            <div className={`answer-area${playing ? ' story' : ''}`}>
              {!playing && (
                <header className="answer-head" aria-live="polite">
                  <div className="read-as">{asking ? `Asking ${ENGINE_NAME[engine]}: “${question}”` : a?.read_as ?? (rejected ? 'Not one of the questions I can answer yet' : '')}</div>
                  {a && <p className={`answer-sentence${asking ? ' muted' : ''}`}>{a.answer}</p>}
                  {!a && asking && <p className="answer-sentence muted">Finding the answer in the graph…</p>}
                </header>
              )}
              <GraphStage
                graph={story.view?.graph ?? a?.graph ?? null} animKey={animKey} loading={asking}
                title={playing ? undefined : a?.title} reveal={story.view?.reveal ?? null} focus={story.view?.focus ?? null}
                flyKey={story.view?.flyKey ?? 0} story={playing} view={view} onView={setView}
              >
                {story.view && <StoryCaption view={story.view} onSkip={story.stop} />}
                {story.error && !playing && <div className="story-caption"><div className="notice err">The story could not start: {story.error}</div></div>}
              </GraphStage>
              {a && !playing && <TechExplain a={a} onCompare={() => setComparingEngines(true)} comparing={comparingEngines} />}
            </div>
          )}
          {!playing && (
            <AskDock
              docked={answering} asking={asking} chips={chips.value?.data ?? []} error={askError} rejected={rejected}
              onAsk={onAsk} hint={hint} onDismissHint={dismissHint}
            />
          )}
        </main>

        <ResponsePanel
          event={event} run={run} phases={phases} running={running} approving={approving} runError={runError}
          me={me} onMe={setMe} onAnalyze={runAgents} onDecide={decide} tech={false}
          influence={influence} memoryOnFile={onFile.value?.data ?? null}
          onCompare={() => setComparingMemory(true)} onOpenMemory={() => setTab('memory')}
          others={evList.filter(e => e.id !== event?.id)} onSwitchEvent={id => setEventId(id)}
        />
      </div>

      {comparingEngines && question && <CompareSheet tenant={tenant} question={question} onClose={() => setComparingEngines(false)} />}
      {comparingMemory && run && <MemoryCompare tenant={tenant} runId={run.id} tech onClose={() => setComparingMemory(false)} />}
      {tab && !playing && (
        <Drawer tab={tab} onTab={setTab} onClose={() => setTab(null)} tenant={tenant} tenants={tenants} engine={engine} event={event} run={run} />
      )}
    </div>
  )
}
