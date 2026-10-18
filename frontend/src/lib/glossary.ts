// Plain-English explanations for every technical term the UI shows, and the "How it was found"
// steps per question type (plain words first, the technical name second).

export const TERMS = {
  groups: 'Separate pile-ups of late orders that can be fixed separately. Found with Weakly Connected Components (WCC) over the supply-chain links.',
  root: 'The stuck shipment a group of late orders waits on. Rescue it and that whole group is back on time ("root shipment").',
  cluster: 'A group of late orders that share one cause (a "cluster"). Fixing its root shipment fixes the group.',
  betweenness: 'How many of the shortest routes between our places pass through a hub ("betweenness centrality"). High = everything depends on it.',
  exposure: 'Late fees due if nothing is done: days late times each order\'s daily penalty.',
  delayed: 'Every shipment the delay reaches, directly at the closed port or further down the supply chain.',
  atRisk: 'Orders that will now arrive after the date we promised the customer.',
  trackRecord: 'What a kind of move actually saved in past outcomes, as a share of what was expected when it was approved.',
  whatIf: 'The delay cascade re-run as if the rescue happened, to see which late fees it removes ("what-if cascade").',
  cascade: 'Following the delay from the closed port along the supply chain, step by step, minus the slack at each step.',
  engine: 'Choose which database answers your questions. Agents and memory always run on FalkorDB.',
} as const

type Steps = [plain: string, technical: string][]
const RISK: Steps = [
  ['Find the shipments that pass through the closed port while it is shut', 'legs touching the closed :Hub inside the event window'],
  ['Follow each delay along the supply chain, step by step, subtracting the slack at every step', 'variable-length (:Shipment)-[:FEEDS*0..8]->() path with reduce()'],
  ['Keep the orders that now arrive after their promised date, and price each day late', 'Promise.due_day, penalty_per_day'],
]
export const HOW_FOUND: Record<string, Steps> = {
  at_risk: RISK,
  top_loss_orders: [...RISK, ['Rank those orders by late fee and keep the costliest', 'ORDER BY fee DESC, promise id; LIMIT n (1-50)']],
  orders_window: [
    ['Find the customers in that city', ':Customer {city}'],
    ['Keep their orders promised inside the date range', 'Promise.due_day between the two dates'],
    ['See where each one ships from and whether it arrives in time', '(:Order)-[:FULFILLED_BY]->(:Shipment)-[:USES]->(:Leg)-[:FROM]->(:Hub)'],
  ],
  why_late: [
    ['Start from the customer\'s order and the parcel that carries it', '(:Customer)-[:PLACED]->(:Order)-[:FULFILLED_BY]->(:Shipment)'],
    ['Walk back up the supply chain to the shipment stuck at the closed port', 'the worst-delay FEEDS path from the hit shipment'],
    ['Show how late each step leaves, after its slack', 'delay minus FEEDS.buffer_days, step by step'],
  ],
  rescue_first: [
    ['Mark every shipment the delay reaches', 'tag :Impacted shipments from the cascade'],
    ['Split them into independent groups', 'algo.WCC (Weakly Connected Components) over FEEDS'],
    ['Rank the groups by late fees and name the shipment each one waits on', 'root shipments, summed penalties'],
  ],
  weak_points: [
    ['For every place, count how many shortest routes between our places pass through it', 'algo.betweenness (exact, every hub sampled)'],
    ['Show the top places and the lanes between them', ':LANE relationships among the top hubs'],
  ],
  reroute: [
    ['Look for the fastest routes from one place to the other, at most 7 legs long', 'algo.SPpaths with maxLen 7'],
    ['Drop every route through the closed place', 'closed hubs filtered out'],
    ['Keep the three fastest and name the cheapest of them', 'by days, then cost per kg'],
  ],
}
