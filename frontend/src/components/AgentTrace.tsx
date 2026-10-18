import type { Answer, Run } from '../api/types'

// "Step by step": how the answer, or the agents' run, was worked out in FalkorDB, one plain step at
// a time. Shown beside the diagram or globe when the user turns on the split view. Picking a step
// calls onHighlight with the graph ids that step touched, so the left side lights them up.
// Stub wired into GraphStage on Oct 18; the agent work replaces the body.
export interface TraceHighlight { key: string; ids: string[]; label?: string }
export interface AgentTraceProps {
  tenant: string
  eventId: string | null
  answer: Answer | null     // the current question's answer (always there when the split view is open)
  run: Run | null           // the latest agent run, if any (updates live while it streams)
  reduced: boolean
  highlightKey: string | null
  onHighlight: (h: TraceHighlight | null) => void
}

export default function AgentTrace({ answer, run }: AgentTraceProps) {
  return <div className="stage-empty">Step-by-step trace coming ({run ? `${run.decisions.length} agent decisions` : answer?.template ?? 'no answer'}).</div>
}
