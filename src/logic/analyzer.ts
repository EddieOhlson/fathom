import type { AssetItem } from '@adamscloudera/octopai-api'
import type {
  LineageResult, LineageNodeRaw, ToolBreakdownEntry, ConnectionBreakdownEntry,
  DegreeEntry, CrossToolFlow, FathomInsights, LineageDashboard,
  DuplicateFlowNode, DuplicateFlowGroup, ConnectionHealthEntry, SchemaCoverageEntry,
  PipelineChain, PipelineDepthStats,
} from './types.ts'

const MAX_TOP = 10
const MAX_ORPHANS = 20

const MIN_SAMPLES_PER_TOOL = 10

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type LineageIndex = {
  nodeMap: Map<string, LineageNodeRaw>
  edgeIn: Map<string, number>
  edgeOut: Map<string, number>
  assetByKey: Map<string, AssetItem>
  toolByKey: Map<string, string>
  bareKey: (k: string) => string
  lookupAsset: (k: string) => AssetItem | undefined
  lookupTool: (k: string) => string | undefined
}

// ---------------------------------------------------------------------------
// Sub-functions
// ---------------------------------------------------------------------------

export type CatalogAccumulator = {
  toolCounts: Map<string, { toolType: string; count: number }>
  connCounts: Map<string, { toolName: string; count: number }>
  dbs: Set<string>
  schemas: Set<string>
}

export function createCatalogAccumulator(): CatalogAccumulator {
  return { toolCounts: new Map(), connCounts: new Map(), dbs: new Set(), schemas: new Set() }
}

// Folds ONLY the given (new) assets into an existing accumulator -- O(newAssets),
// never O(everything seen so far). Call this once per page during a progressive
// fetch; never re-run it over the full running total, or the cost of every
// subsequent page grows with how much has already been fetched.
export function updateCatalogAccumulator(acc: CatalogAccumulator, newAssets: AssetItem[]): void {
  const { toolCounts, connCounts, dbs, schemas } = acc
  for (const a of newAssets) {
    const tool = a.toolName ?? 'Unknown'
    const existing = toolCounts.get(tool)
    if (existing) { existing.count++ } else { toolCounts.set(tool, { toolType: a.toolType ?? 'Unknown', count: 1 }) }

    const conn = a.connectionName ?? 'Unknown'
    const existingConn = connCounts.get(conn)
    if (existingConn) { existingConn.count++ } else { connCounts.set(conn, { toolName: a.toolName ?? 'Unknown', count: 1 }) }

    if (a.databaseName && a.databaseName !== '-1') dbs.add(a.databaseName.toLowerCase())
    if (a.schemaName && a.schemaName !== '-1') {
      schemas.add(`${a.databaseName ?? ''}.${a.schemaName}`.toLowerCase())
    }
  }
}

// Cheap: O(distinct tools + distinct connections), never O(total assets seen).
// Safe to call after every page.
export function deriveCatalogStats(acc: CatalogAccumulator): {
  toolBreakdown: ToolBreakdownEntry[]
  connectionBreakdown: ConnectionBreakdownEntry[]
  distinctDatabases: number
  distinctSchemas: number
} {
  const toolBreakdown: ToolBreakdownEntry[] = [...acc.toolCounts.entries()]
    .map(([toolName, { toolType, count }]) => ({ toolName, toolType, count }))
    .sort((a, b) => b.count - a.count)

  const connectionBreakdown: ConnectionBreakdownEntry[] = [...acc.connCounts.entries()]
    .map(([connectionName, { toolName, count }]) => ({ connectionName, toolName, count }))
    .sort((a, b) => b.count - a.count)

  return { toolBreakdown, connectionBreakdown, distinctDatabases: acc.dbs.size, distinctSchemas: acc.schemas.size }
}

// One-shot convenience for the final, complete-catalog analysis pass (called
// once in analyze(), not per-page -- O(assets.length) exactly once is fine).
export function buildCatalogStats(assets: AssetItem[]): {
  toolBreakdown: ToolBreakdownEntry[]
  connectionBreakdown: ConnectionBreakdownEntry[]
  distinctDatabases: number
  distinctSchemas: number
} {
  const acc = createCatalogAccumulator()
  updateCatalogAccumulator(acc, assets)
  return deriveCatalogStats(acc)
}

function buildLineageIndex(assets: AssetItem[], lineageResults: LineageResult[]): LineageIndex {
  // Index assets by both their full _key and the bare id after the last '/'
  // because the lineage API returns nodes with ArangoDB collection/id keys
  // (e.g. "objects/abc123") while the catalog uses the bare id ("abc123").
  const assetByKey = new Map<string, AssetItem>()
  for (const a of assets) {
    assetByKey.set(a._key, a)
    const slash = a._key.lastIndexOf('/')
    if (slash >= 0) assetByKey.set(a._key.slice(slash + 1), a)
  }

  const toolByKey = new Map<string, string>()
  for (const a of assets) {
    if (!a.toolName) continue
    toolByKey.set(a._key, a.toolName)
    const slash = a._key.lastIndexOf('/')
    if (slash >= 0) toolByKey.set(a._key.slice(slash + 1), a.toolName)
  }

  const bareKey = (k: string) => { const s = k.lastIndexOf('/'); return s >= 0 ? k.slice(s + 1) : k }

  // Collect best connectivity reading per unique node key
  const nodeMap = new Map<string, LineageNodeRaw>()
  for (const result of lineageResults) {
    for (const node of result.nodes) {
      const existing = nodeMap.get(node._key)
      if (!existing || (node.ins ?? 0) + (node.outs ?? 0) > (existing.ins ?? 0) + (existing.outs ?? 0)) {
        nodeMap.set(node._key, node)
        if (node.toolName) toolByKey.set(node._key, node.toolName)
      }
    }
  }

  // Compute in/out degree from sampled edges. Used when the API doesn't populate
  // ins/outs on nodes (varies by tenant/version).
  const edgeIn = new Map<string, number>()
  const edgeOut = new Map<string, number>()
  for (const result of lineageResults) {
    for (const edge of result.edges) {
      const f = bareKey(edge.from)
      const t = bareKey(edge.to)
      if (f) edgeOut.set(f, (edgeOut.get(f) ?? 0) + 1)
      if (t) edgeIn.set(t, (edgeIn.get(t) ?? 0) + 1)
    }
  }

  const lookupAsset = (key: string): AssetItem | undefined => {
    const direct = assetByKey.get(key)
    if (direct) return direct
    const slash = key.lastIndexOf('/')
    return slash >= 0 ? assetByKey.get(key.slice(slash + 1)) : undefined
  }

  const lookupTool = (key: string): string | undefined => {
    const direct = toolByKey.get(key)
    if (direct) return direct
    const slash = key.lastIndexOf('/')
    return slash >= 0 ? toolByKey.get(key.slice(slash + 1)) : undefined
  }

  return { nodeMap, edgeIn, edgeOut, assetByKey, toolByKey, bareKey, lookupAsset, lookupTool }
}

function computeDuplicateFlows(lineageResults: LineageResult[], index: LineageIndex): DuplicateFlowGroup[] {
  const { bareKey, nodeMap, lookupAsset } = index

  // Duplicate flow detection: find target objects sharing identical upstream source sets.
  // Target→sources map keyed by bare node key.
  const targetSourcesMap = new Map<string, Set<string>>()
  for (const result of lineageResults) {
    for (const edge of result.edges) {
      const fromBk = bareKey(edge.from)
      const toBk = bareKey(edge.to)
      if (!fromBk || !toBk || fromBk === toBk) continue
      if (!targetSourcesMap.has(toBk)) targetSourcesMap.set(toBk, new Set())
      targetSourcesMap.get(toBk)!.add(fromBk)
    }
  }

  const fpToTargets = new Map<string, string[]>()
  for (const [targetBk, sourceSet] of targetSourcesMap.entries()) {
    if (sourceSet.size < 2) continue  // require >= 2 shared sources to reduce ETL fan-out false positives
    const fp = [...sourceSet].sort().join('§')
    if (!fpToTargets.has(fp)) fpToTargets.set(fp, [])
    fpToTargets.get(fp)!.push(targetBk)
  }

  function nodeInfo(bk: string): DuplicateFlowNode {
    const node = nodeMap.get(bk)
    const asset = lookupAsset(bk)
    return {
      key: bk,
      objectName: node?.objectName ?? asset?.objectName ?? bk,
      connectionName: node?.connectionName ?? asset?.connectionName ?? '',
      objectType: node?.objectType ?? asset?.objectType ?? '',
      toolName: node?.toolName ?? asset?.toolName ?? '',
      toolType: node?.toolType ?? asset?.toolType ?? '',
    }
  }

  return [...fpToTargets.entries()]
    .filter(([, targets]) => targets.length >= 2)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 20)
    .map(([fp, targetBks], i) => ({
      id: `dup-${i}`,
      sources: fp.split('§').map(nodeInfo),
      targets: targetBks.map(nodeInfo),
    }))
}

function computeConnectionHealth(allDegrees: DegreeEntry[]): ConnectionHealthEntry[] {
  // Per-connection lineage coverage from lineage sample
  const connHealthMap = new Map<string, { toolName: string; toolType: string; degrees: number[] }>()
  for (const e of allDegrees) {
    const conn = e.connectionName || 'Unknown'
    if (!connHealthMap.has(conn)) {
      connHealthMap.set(conn, {
        toolName: e.toolName ?? 'Unknown',
        toolType: e.toolType ?? 'Unknown',
        degrees: [],
      })
    }
    connHealthMap.get(conn)!.degrees.push(e.degree)
  }

  return [...connHealthMap.entries()]
    .map(([connectionName, { toolName, toolType, degrees }]) => {
      const totalSeen = degrees.length
      const withLineage = degrees.filter((d) => d > 0).length
      const orphanCount = totalSeen - withLineage
      const sum = degrees.reduce((s, d) => s + d, 0)
      const avgDegree = totalSeen > 0 ? Math.round((sum / totalSeen) * 10) / 10 : 0
      const maxDegree = degrees.length > 0 ? Math.max(...degrees) : 0
      const coverageRate = totalSeen > 0 ? withLineage / totalSeen : 0
      return { connectionName, toolName, toolType, totalSeen, withLineage, orphanCount, avgDegree, maxDegree, coverageRate }
    })
    .sort((a, b) => a.coverageRate - b.coverageRate)
}

function computeSchemaCoverage(allDegrees: DegreeEntry[]): SchemaCoverageEntry[] {
  // Group allDegrees by (connection, database, schema) and compute lineage rate
  const schemaCoverageMap = new Map<string, { connectionName: string; databaseName: string; schemaName: string; toolName: string; totalSeen: number; withLineage: number }>()
  for (const e of allDegrees) {
    const conn = e.connectionName || 'Unknown'
    const db = e.databaseName || 'Unknown'
    const schema = e.schemaName || 'Unknown'
    const key = `${conn}||${db}||${schema}`
    const existing = schemaCoverageMap.get(key)
    if (existing) {
      existing.totalSeen++
      if (e.degree > 0) existing.withLineage++
    } else {
      schemaCoverageMap.set(key, {
        connectionName: conn,
        databaseName: db,
        schemaName: schema,
        toolName: e.toolName ?? 'Unknown',
        totalSeen: 1,
        withLineage: e.degree > 0 ? 1 : 0,
      })
    }
  }

  return [...schemaCoverageMap.entries()]
    .map(([key, { connectionName, databaseName, schemaName, toolName, totalSeen, withLineage }]) => ({
      key,
      connectionName,
      databaseName,
      schemaName,
      toolName,
      totalSeen,
      withLineage,
      coverageRate: totalSeen > 0 ? withLineage / totalSeen : 0,
    }))
    .sort((a, b) => a.coverageRate - b.coverageRate)
    .slice(0, 200)
}

function computePipelineDepth(lineageResults: LineageResult[], index: LineageIndex): PipelineDepthStats | null {
  const { bareKey, nodeMap, lookupAsset } = index

  // Build DAG from sampled edges, then DP longest path (Kahn's)
  const adj = new Map<string, string[]>()
  const inDeg = new Map<string, number>()
  const dagNodes = new Set<string>()

  for (const result of lineageResults) {
    for (const edge of result.edges) {
      const f = bareKey(edge.from), t = bareKey(edge.to)
      if (!f || !t || f === t) continue
      dagNodes.add(f); dagNodes.add(t)
      if (!adj.has(f)) adj.set(f, [])
      adj.get(f)!.push(t)
      inDeg.set(t, (inDeg.get(t) ?? 0) + 1)
      if (!inDeg.has(f)) inDeg.set(f, 0)
    }
  }

  const dist = new Map<string, number>()   // node -> longest path length TO this node
  const prev = new Map<string, string>()   // node -> predecessor on longest path
  const inDegCopy = new Map(inDeg)
  const queue: string[] = []
  for (const [k, d] of inDeg.entries()) { if (d === 0) { queue.push(k); dist.set(k, 0) } }

  while (queue.length > 0) {
    const u = queue.shift()!
    for (const v of (adj.get(u) ?? [])) {
      const nd = (dist.get(u) ?? 0) + 1
      if (nd > (dist.get(v) ?? -1)) { dist.set(v, nd); prev.set(v, u) }
      inDegCopy.set(v, (inDegCopy.get(v) ?? 1) - 1)
      if (inDegCopy.get(v) === 0) queue.push(v)
    }
  }

  const nodeLabel = (k: string): string => {
    const n = nodeMap.get(k); const a = lookupAsset(k)
    return (n && n.objectName) || (a && a.objectName) || k
  }

  const terminals = [...dist.entries()]
    .filter(([k]) => !adj.has(k) || adj.get(k)!.length === 0)
    .sort((a, b) => b[1] - a[1]).slice(0, 10)

  const tracePath = (end: string): string[] => {
    const path: string[] = []; let cur: string | undefined = end
    while (cur !== undefined) { path.unshift(cur); cur = prev.get(cur) }
    return path
  }

  const longestChains: PipelineChain[] = terminals.map(([k, depth]) => {
    const pathKeys = tracePath(k)
    return { depth, pathLabels: pathKeys.map(nodeLabel), sourceLabel: nodeLabel(pathKeys[0] ?? ''), targetLabel: nodeLabel(k) }
  })

  const allDistValues = [...dist.values()]
  const depthDistribution: Record<number, number> = {}
  for (const d of allDistValues) depthDistribution[d] = (depthDistribution[d] ?? 0) + 1

  return allDistValues.length === 0 ? null : {
    maxDepth: Math.max(...allDistValues),
    avgDepth: Math.round((allDistValues.reduce((a, b) => a + b, 0) / allDistValues.length) * 10) / 10,
    depthDistribution,
    longestChains,
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function selectSampleKeys(assets: AssetItem[], maxKeys = 200): string[] {
  // Group by toolName so every tool is represented, then fill proportionally.
  // This avoids under-sampling small tools (e.g. 238-object ETL tool in 10k catalog)
  // that would otherwise get 2-3 samples and produce false "isolated tool" positives.
  const byTool = new Map<string, string[]>()
  for (const a of assets) {
    const tool = a.toolName ?? '__unknown__'
    if (!byTool.has(tool)) byTool.set(tool, [])
    byTool.get(tool)!.push(a._key)
  }
  const toolCount = byTool.size || 1
  const perTool = Math.max(MIN_SAMPLES_PER_TOOL, Math.ceil(maxKeys / toolCount))
  const selected: string[] = []
  for (const keys of byTool.values()) {
    const quota = Math.min(perTool, keys.length)
    const step = Math.max(1, Math.floor(keys.length / quota))
    for (let i = 0; i < keys.length && selected.length < maxKeys; i += step) {
      selected.push(keys[i])
    }
  }
  return selected.slice(0, maxKeys)
}

function toDegreeEntry(node: LineageNodeRaw, fallbackAsset?: AssetItem, inFallback = 0, outFallback = 0): DegreeEntry {
  // Prefer API-reported values (global count across all lineage).
  // Fall back to edge-sampled count for tenants that don't return ins/outs.
  const ins = node.ins ?? inFallback
  const outs = node.outs ?? outFallback
  const toolName = node.toolName || fallbackAsset?.toolName
  const toolType = node.toolType || fallbackAsset?.toolType
  return {
    key: node._key,
    objectName: node.objectName || fallbackAsset?.objectName || '',
    connectionName: node.connectionName || fallbackAsset?.connectionName || '',
    databaseName: node.databaseName || fallbackAsset?.databaseName || '',
    schemaName: node.schemaName || fallbackAsset?.schemaName || '',
    objectType: node.objectType || fallbackAsset?.objectType || '',
    ...(toolName ? { toolName } : {}),
    ...(toolType ? { toolType } : {}),
    degree: ins + outs,
    ins,
    outs,
  }
}

export function analyze(
  tenantName: string,
  assets: AssetItem[],
  lineageResults: LineageResult[],
  catalogPhaseDurationMs: number,
  lineagePhaseDurationMs: number,
  fetchedAt: string,
  lineageDashboard: LineageDashboard | null = null,
  columnDashboard: LineageDashboard | null = null,
): FathomInsights {
  const { toolBreakdown, connectionBreakdown, distinctDatabases, distinctSchemas } = buildCatalogStats(assets)
  const index = buildLineageIndex(assets, lineageResults)
  const { nodeMap, edgeIn, edgeOut, bareKey, lookupAsset, lookupTool } = index

  const allDegrees: DegreeEntry[] = [...nodeMap.values()].map((n) => {
    const bk = bareKey(n._key)
    return toDegreeEntry(
      n,
      lookupAsset(n._key),
      edgeIn.get(bk) ?? edgeIn.get(n._key) ?? 0,
      edgeOut.get(bk) ?? edgeOut.get(n._key) ?? 0,
    )
  })

  const confirmedOrphans = allDegrees
    .filter((e) => e.ins === 0 && e.outs === 0)
    .slice(0, MAX_ORPHANS)

  const withConnections = allDegrees.filter((e) => e.degree > 0)
  const topByDegree = [...withConnections].sort((a, b) => b.degree - a.degree).slice(0, MAX_TOP)
  const lowDegree = [...withConnections].sort((a, b) => a.degree - b.degree).slice(0, MAX_TOP)
  const allConnectedDegrees = [...withConnections].sort((a, b) => b.degree - a.degree)

  const duplicateFlowGroups = computeDuplicateFlows(lineageResults, index)
  const connectionHealth = computeConnectionHealth(allDegrees)
  const schemaCoverage = computeSchemaCoverage(allDegrees)
  const pipelineDepth = computePipelineDepth(lineageResults, index)

  // Cross-tool flows via edges
  const crossToolMap = new Map<string, number>()
  for (const result of lineageResults) {
    for (const edge of result.edges) {
      const fromTool = lookupTool(edge.from)
      const toTool = lookupTool(edge.to)
      if (fromTool && toTool && fromTool !== toTool) {
        const key = `${fromTool}→${toTool}`
        crossToolMap.set(key, (crossToolMap.get(key) ?? 0) + 1)
      }
    }
  }
  const crossToolFlows: CrossToolFlow[] = [...crossToolMap.entries()]
    .map((entry) => {
      const [fromTool, toTool] = entry[0].split('→')
      return { fromTool, toTool, linkCount: entry[1] }
    })
    .sort((a, b) => b.linkCount - a.linkCount)

  // Coverage rate: fraction of sampled keys whose lineage query returned any edges
  const coveredCount = lineageResults.filter((r) => r.edges.length > 0).length
  const lineageCoverageRate = lineageResults.length > 0 ? coveredCount / lineageResults.length : 0

  const inferredInsights = buildInferredInsights({
    toolBreakdown, distinctDatabases, distinctSchemas,
    lineageCoverageRate, lineageSampledCount: lineageResults.length,
    confirmedOrphans, topByDegree, crossToolFlows, lineageDashboard,
  })

  return {
    tenantName,
    fetchedAt,
    catalogPhaseDurationMs,
    lineagePhaseDurationMs,
    totalAssets: assets.length,
    toolBreakdown,
    distinctDatabases,
    distinctSchemas,
    connectionBreakdown,
    lineageSampledCount: lineageResults.length,
    lineageCoverageRate,
    confirmedOrphans,
    topByDegree,
    lowDegree,
    allConnectedDegrees,
    crossToolFlows,
    duplicateFlowGroups,
    inferredInsights,
    lineageDashboard,
    columnDashboard,
    connectionHealth,
    schemaCoverage,
    pipelineDepth,
  }
}

type InsightInputs = {
  toolBreakdown: ToolBreakdownEntry[]
  distinctDatabases: number
  distinctSchemas: number
  lineageCoverageRate: number
  lineageSampledCount: number
  confirmedOrphans: DegreeEntry[]
  topByDegree: DegreeEntry[]
  crossToolFlows: CrossToolFlow[]
  lineageDashboard: LineageDashboard | null
}

function buildInferredInsights(i: InsightInputs): string[] {
  const out: string[] = []

  // Catalog breadth
  const toolCount = i.toolBreakdown.length
  if (toolCount >= 2) {
    const dbTools = i.toolBreakdown.filter((t) => t.toolType === 'DB').length
    const etlTools = i.toolBreakdown.filter((t) => t.toolType === 'ETL').length
    const biTools = i.toolBreakdown.filter((t) => t.toolType === 'REPORT').length
    const parts: string[] = []
    if (dbTools > 0) parts.push(`${dbTools} DB`)
    if (etlTools > 0) parts.push(`${etlTools} ETL`)
    if (biTools > 0) parts.push(`${biTools} BI/reporting`)
    out.push(
      `Catalog spans ${toolCount} tool${toolCount === 1 ? '' : 's'} (${parts.join(', ')}) across ${i.distinctDatabases} database${i.distinctDatabases === 1 ? '' : 's'}.`
    )
  }

  // Lineage coverage
  if (i.lineageSampledCount > 0) {
    const pct = Math.round(i.lineageCoverageRate * 100)
    if (pct < 30) {
      out.push(
        `Low lineage coverage: only ${pct}% of sampled objects have active connections. Harvesting may be incomplete or connections recently added.`
      )
    } else if (pct >= 70) {
      out.push(`Strong lineage coverage: ${pct}% of sampled objects have active connections.`)
    }
  }

  // Orphans
  if (i.confirmedOrphans.length > 0) {
    out.push(
      `${i.confirmedOrphans.length} orphaned object${i.confirmedOrphans.length === 1 ? '' : 's'} found with no lineage connections — likely missing connector coverage or inactive tables.`
    )
  }

  // Cross-tool flows
  if (i.crossToolFlows.length > 0) {
    const top = i.crossToolFlows[0]
    out.push(
      `Most active cross-tool flow: ${top.fromTool} → ${top.toTool} (${top.linkCount} link${top.linkCount === 1 ? '' : 's'} in sample).`
    )
  }

  // Isolated tools (have assets but no cross-tool edges in sample).
  // Suppress the warning for any tool confirmed active in the Lineage Dashboard
  // (authoritative count from the UI) — those are sampling gaps, not real isolation.
  if (i.lineageSampledCount > 0) {
    const toolsInFlows = new Set(i.crossToolFlows.flatMap((f) => [f.fromTool, f.toTool]))
    const toolsInDashboard = new Set<string>()
    if (i.lineageDashboard) {
      for (const bucket of [i.lineageDashboard.etl, i.lineageDashboard.db, i.lineageDashboard.report]) {
        Object.keys(bucket.byTool).forEach((t) => toolsInDashboard.add(t))
      }
    }
    const isolated = i.toolBreakdown
      .filter((t) => !toolsInFlows.has(t.toolName) && !toolsInDashboard.has(t.toolName))
      .map((t) => t.toolName)
    if (isolated.length > 0) {
      out.push(
        `No cross-tool lineage detected for: ${isolated.join(', ')}. These tools may be isolated or require additional harvesting.`
      )
    }
  }

  // High-value object
  if (i.topByDegree.length > 0) {
    const top = i.topByDegree[0]
    out.push(
      `Most connected object: ${top.objectName}${top.connectionName ? ` (${top.connectionName})` : ''} — degree ${top.degree} (${top.ins} in, ${top.outs} out).`
    )
  }

  return out
}
