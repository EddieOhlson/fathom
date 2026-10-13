import type { AssetItem } from '@adamscloudera/octopai-api'

export type { AssetItem }

export type LineageNodeRaw = {
  _key: string
  objectName?: string
  schemaName?: string
  databaseName?: string
  objectType?: string
  connectionName?: string
  toolName?: string
  toolType?: string
  objectGUID?: string
  ins?: number
  outs?: number
}

export type LineageEdge = {
  from: string
  to: string
  type?: string
}

export type LineageResult = {
  queryKey: string
  nodes: LineageNodeRaw[]
  edges: LineageEdge[]
}

export type ToolBreakdownEntry = {
  toolName: string
  toolType: string
  count: number
}

export type ConnectionBreakdownEntry = {
  connectionName: string
  toolName: string
  count: number
}

export type DegreeEntry = {
  key: string
  objectName: string
  connectionName: string
  databaseName: string
  schemaName: string
  objectType: string
  toolName?: string
  toolType?: string
  degree: number
  ins: number
  outs: number
}

export type DuplicateFlowNode = {
  key: string
  objectName: string
  connectionName: string
  objectType: string
  toolName: string
  toolType: string
}

export type DuplicateFlowGroup = {
  id: string
  sources: DuplicateFlowNode[]
  targets: DuplicateFlowNode[]
}

export type CrossToolFlow = {
  fromTool: string
  toTool: string
  linkCount: number
}

export type LineageDashboardBucket = {
  total: number
  byTool: Record<string, number>
}

export type LineageDashboard = {
  etl: LineageDashboardBucket
  db: LineageDashboardBucket
  report: LineageDashboardBucket
}

export type DeepOrphanEntry = {
  key: string
  objectName: string
  connectionName: string
  databaseName: string
  schemaName: string
  objectType: string
  toolName: string
  toolType: string
  source: 'sample' | 'deep' | 'quick'
}

export type DeepScanProgress = {
  done: number
  total: number
  startedAt: number
}

export type ConnectionHealthEntry = {
  connectionName: string
  toolName: string
  toolType: string
  totalSeen: number
  withLineage: number
  orphanCount: number
  avgDegree: number
  maxDegree: number
  coverageRate: number
}

export type SchemaCoverageEntry = {
  key: string
  connectionName: string
  databaseName: string
  schemaName: string
  toolName: string
  totalSeen: number
  withLineage: number
  coverageRate: number
}

export type PipelineChain = {
  depth: number
  pathLabels: string[]   // objectName of each node source-to-target
  sourceLabel: string
  targetLabel: string
}

export type PipelineDepthStats = {
  maxDepth: number
  avgDepth: number
  depthDistribution: Record<number, number>  // depth -> chain count at that depth
  longestChains: PipelineChain[]             // top 10 deepest
}

export type ColumnScanNode = {
  key: string
  columnName: string    // assetName — the column identifier
  tableName: string     // objectName after normalization — parent table
  connectionName: string
  databaseName: string
  schemaName: string
  toolName: string
  toolType: string
}

export type ColumnMatchResult = {
  key: string
  columnName: string    // assetName — what matched the keyword
  tableName: string     // objectName after normalization — parent table
  dataType: string
  connectionName: string
  databaseName: string
  schemaName: string
  toolName: string
  toolType: string
  upstreamColumns: ColumnScanNode[]
  downstreamColumns: ColumnScanNode[]
  lineageFetched: boolean
}

export type FathomInsights = {
  tenantName: string
  fetchedAt: string
  catalogPhaseDurationMs: number
  lineagePhaseDurationMs: number
  totalAssets: number
  toolBreakdown: ToolBreakdownEntry[]
  distinctDatabases: number
  distinctSchemas: number
  connectionBreakdown: ConnectionBreakdownEntry[]
  lineageSampledCount: number
  lineageCoverageRate: number
  confirmedOrphans: DegreeEntry[]
  topByDegree: DegreeEntry[]
  lowDegree: DegreeEntry[]
  allConnectedDegrees: DegreeEntry[]
  crossToolFlows: CrossToolFlow[]
  duplicateFlowGroups: DuplicateFlowGroup[]
  inferredInsights: string[]
  lineageDashboard: LineageDashboard | null
  columnDashboard: LineageDashboard | null
  connectionHealth: ConnectionHealthEntry[]
  schemaCoverage: SchemaCoverageEntry[]
  pipelineDepth: PipelineDepthStats | null
}
