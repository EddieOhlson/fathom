import { useState, useRef, useMemo, useEffect } from 'react'
import { ScanSearch, Zap, X, AlertCircle, CheckCircle2, Download } from 'lucide-react'
import { clsx } from 'clsx'
import { downloadCsv, FilterTabs } from '../lib/reportUtils.tsx'
import type { FathomInsights, DeepOrphanEntry } from '../logic/types.ts'
import { useInsightsStore } from '../stores/useInsightsStore.ts'
import { useSessionStore } from '../stores/useSessionStore.ts'
import {
  runOrphanScan,
  selectScanCandidates,
  estimateScanSeconds,
  type ScanMode,
} from '../logic/orphanScan.ts'
import type { AssetItem } from '@adamscloudera/octopai-api'

type ToolFilter = 'all' | 'DB' | 'ETL'


function buildAssetMap(assets: AssetItem[]): Map<string, AssetItem> {
  const m = new Map<string, AssetItem>()
  for (const a of assets) {
    m.set(a._key, a)
    const s = a._key.lastIndexOf('/')
    if (s >= 0) m.set(a._key.slice(s + 1), a)
  }
  return m
}

function sampleOrphansToEntries(
  confirmedOrphans: FathomInsights['confirmedOrphans'],
  assetMap: Map<string, AssetItem>,
): DeepOrphanEntry[] {
  return confirmedOrphans.map((o) => {
    const bk = o.key.lastIndexOf('/') >= 0 ? o.key.slice(o.key.lastIndexOf('/') + 1) : o.key
    const asset = assetMap.get(o.key) ?? assetMap.get(bk)
    return {
      key: o.key,
      objectName: o.objectName,
      connectionName: o.connectionName,
      databaseName: o.databaseName,
      schemaName: o.schemaName,
      objectType: o.objectType,
      toolName: asset?.toolName ?? '',
      toolType: asset?.toolType ?? '',
      source: 'sample',
    }
  })
}

function mergeOrphans(
  sample: DeepOrphanEntry[],
  scanned: DeepOrphanEntry[] | null,
): DeepOrphanEntry[] {
  if (!scanned) return sample
  const byKey = new Map<string, DeepOrphanEntry>()
  for (const e of sample) byKey.set(e.key, e)
  // Scan entries (deep or quick) win on duplicates (more authoritative)
  for (const e of scanned) byKey.set(e.key, e)
  return [...byKey.values()].sort((a, b) => a.objectName.localeCompare(b.objectName))
}

function fmtSecs(s: number): string {
  if (s < 60) return `~${s}s`
  return `~${Math.ceil(s / 60)}m`
}

function scanLabel(mode: ScanMode | null): string {
  return mode === 'quick' ? 'Quick scan' : 'Deep scan'
}

type Props = { insights: FathomInsights }

export function OrphanedObjectsReport({ insights }: Props) {
  const {
    rawAssets,
    scanOrphans,
    scanProgress,
    scanStatus,
    scanError,
    scanMode,
    setScanOrphans,
    setScanProgress,
    setScanStatus,
    setScanMode,
  } = useInsightsStore()
  const { company, accessToken } = useSessionStore()

  const [filter, setFilter] = useState<ToolFilter>('all')
  const [elapsed, setElapsed] = useState(0)
  const abortRef = useRef<AbortController | null>(null)
  const startRef = useRef<number>(0)

  useEffect(() => {
    if (scanStatus !== 'scanning' || !scanProgress) {
      setElapsed(0)
      return
    }
    setElapsed(Math.floor((Date.now() - scanProgress.startedAt) / 1000))
    const id = setInterval(
      () => setElapsed(Math.floor((Date.now() - scanProgress.startedAt) / 1000)),
      1000,
    )
    return () => clearInterval(id)
  }, [scanStatus, scanProgress?.startedAt])

  const assetMap = useMemo(() => buildAssetMap(rawAssets), [rawAssets])

  const sampleEntries = useMemo(
    () =>
      sampleOrphansToEntries(insights.confirmedOrphans, assetMap).filter(
        (o) => o.toolType !== 'REPORT',
      ),
    [insights.confirmedOrphans, assetMap],
  )

  const allOrphans = useMemo(
    () => mergeOrphans(sampleEntries, scanOrphans),
    [sampleEntries, scanOrphans],
  )

  const filtered = useMemo(
    () => (filter === 'all' ? allOrphans : allOrphans.filter((o) => o.toolType === filter)),
    [allOrphans, filter],
  )

  const countsByType = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const o of allOrphans) {
      counts[o.toolType] = (counts[o.toolType] ?? 0) + 1
    }
    return counts
  }, [allOrphans])

  const deepCandidates = useMemo(() => selectScanCandidates(rawAssets, 'deep'), [rawAssets])
  const quickCandidates = useMemo(() => selectScanCandidates(rawAssets, 'quick'), [rawAssets])
  const deepEstimatedSecs = useMemo(() => estimateScanSeconds(rawAssets, 'deep'), [rawAssets])
  const quickEstimatedSecs = useMemo(() => estimateScanSeconds(rawAssets, 'quick'), [rawAssets])

  const activeCandidates = scanMode === 'quick' ? quickCandidates : deepCandidates

  async function handleScan(mode: ScanMode) {
    if (!accessToken || !company || rawAssets.length === 0) return
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    startRef.current = Date.now()

    const candidates = selectScanCandidates(rawAssets, mode)
    setScanMode(mode)
    setScanStatus('scanning')
    setScanProgress({ done: 0, total: candidates.length, startedAt: startRef.current })

    try {
      const results = await runOrphanScan(
        mode,
        company,
        accessToken,
        rawAssets,
        (done, total) =>
          setScanProgress({ done, total, startedAt: startRef.current }),
        controller.signal,
      )
      if (!controller.signal.aborted) {
        setScanOrphans(results)
        setScanStatus('done')
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setScanStatus('error', err instanceof Error ? err.message : String(err))
      }
    } finally {
      setScanProgress(null)
    }
  }

  function exportCsv() {
    downloadCsv(
      `${insights.tenantName}-orphaned-objects.csv`,
      ['Object', 'Object Type', 'Tool', 'Tool Type', 'Connection', 'Database', 'Schema', 'Source'],
      allOrphans.map((o) => [
        o.objectName, o.objectType, o.toolName, o.toolType,
        o.connectionName, o.databaseName, o.schemaName, o.source,
      ]),
    )
  }

  function handleCancelScan() {
    abortRef.current?.abort()
    setScanStatus('idle')
    setScanProgress(null)
  }

  function badgeLabel(source: DeepOrphanEntry['source']): string {
    if (source === 'deep') return 'deep scan'
    if (source === 'quick') return 'quick scan'
    return 'sample'
  }

  function badgeClass(source: DeepOrphanEntry['source']): string {
    if (source === 'deep') return 'badge-blue'
    if (source === 'quick') return 'bg-teal-100 text-teal-800 border-teal-200'
    return 'bg-amber-100 text-amber-800 border-amber-200'
  }

  const scanPct =
    scanProgress && scanProgress.total > 0
      ? Math.round((scanProgress.done / scanProgress.total) * 100)
      : 0

  return (
    <div className="space-y-4">
      {/* Summary + scan CTAs */}
      <div className="surface-card p-5 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Orphaned Objects</h2>
            <p className="text-xs text-muted mt-0.5">
              ETL jobs and tables with no downstream connections. Reports are excluded — they are terminal nodes by definition.
            </p>
          </div>
          <span className="text-2xl font-bold tabular-nums text-foreground shrink-0">
            {allOrphans.length}
          </span>
        </div>

        {/* Sample caveat */}
        <div className="text-xs text-muted rounded-lg bg-muted/10 border border-border/60 px-3 py-2">
          Initial scan: <span className="text-foreground font-medium">{sampleEntries.length}</span> orphans
          from <span className="text-foreground font-medium">{insights.lineageSampledCount}</span> sampled
          objects out of <span className="text-foreground font-medium">{insights.totalAssets.toLocaleString()}</span> total.
          {scanStatus === 'idle' && ' Run a scan to check more of the catalog.'}
        </div>

        {/* Scan panel */}
        {scanStatus === 'idle' && (
          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={() => handleScan('quick')}
              disabled={rawAssets.length === 0}
              className="btn-primary"
            >
              <Zap className="w-4 h-4" />
              Quick scan
            </button>
            <span className="text-xs text-muted">
              Check {quickCandidates.length.toLocaleString()} objects (~30% sample, {fmtSecs(quickEstimatedSecs)})
            </span>
            <button
              onClick={() => handleScan('deep')}
              disabled={rawAssets.length === 0}
              className="btn-ghost border border-border"
            >
              <ScanSearch className="w-4 h-4" />
              Deep scan
            </button>
            <span className="text-xs text-muted">
              Check all {deepCandidates.length.toLocaleString()} DB + ETL objects ({fmtSecs(deepEstimatedSecs)})
            </span>
          </div>
        )}

        {scanStatus === 'scanning' && scanProgress && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted">
                {scanLabel(scanMode)}: {scanProgress.done.toLocaleString()} / {scanProgress.total.toLocaleString()} objects
              </span>
              <div className="flex items-center gap-3">
                <span className="font-mono text-muted tabular-nums">{elapsed}s</span>
                <button onClick={handleCancelScan} className="btn-ghost text-xs py-0.5 px-2">
                  <X className="w-3 h-3" />
                  Cancel
                </button>
              </div>
            </div>
            <div className="h-2 rounded-full bg-border overflow-hidden">
              <div
                className="h-full rounded-full bg-primary/60 transition-all duration-300"
                style={{ width: `${scanPct}%` }}
              />
            </div>
          </div>
        )}

        {scanStatus === 'done' && scanOrphans !== null && (
          <div className="flex items-center gap-2 text-xs text-green-700">
            <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
            {scanLabel(scanMode)} complete — {scanOrphans.length.toLocaleString()} orphans found across{' '}
            {activeCandidates.length.toLocaleString()} objects scanned.
          </div>
        )}

        {scanStatus === 'error' && scanError && (
          <div className="flex items-start gap-2 text-xs text-red-600">
            <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
            {scanError}
            <button onClick={() => handleScan(scanMode ?? 'deep')} className="underline ml-1">
              Retry
            </button>
          </div>
        )}
      </div>

      {/* Results table */}
      {allOrphans.length > 0 && (
        <div className="surface-card p-5 space-y-3">
          {/* Filter tabs + export */}
          <div className="flex items-center justify-between gap-2 flex-wrap">
          <FilterTabs
            tabs={(['all', 'DB', 'ETL'] as ToolFilter[])
              .filter((t) => t === 'all' || (countsByType[t] ?? 0) > 0)
              .map((t) => ({
                id: t,
                label: t === 'all' ? 'All' : t === 'DB' ? 'Database' : 'ETL',
                count: t === 'all' ? allOrphans.length : (countsByType[t] ?? 0),
              }))}
            active={filter}
            onChange={setFilter}
          />
          <button onClick={exportCsv} className="btn-ghost text-xs shrink-0">
            <Download className="w-3.5 h-3.5" />
            Export CSV
          </button>
          </div>

          {/* Table */}
          <div className="rounded-lg border border-border overflow-hidden overflow-x-auto">
            <table className="w-full text-xs min-w-[640px]">
              <thead>
                <tr className="bg-muted/20 border-b border-border">
                  <th className="text-left px-3 py-2 font-medium text-muted">Object</th>
                  <th className="text-left px-3 py-2 font-medium text-muted">Type</th>
                  <th className="text-left px-3 py-2 font-medium text-muted">Tool</th>
                  <th className="text-left px-3 py-2 font-medium text-muted">Connection</th>
                  <th className="text-left px-3 py-2 font-medium text-muted">Database</th>
                  <th className="text-left px-3 py-2 font-medium text-muted">Source</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((o, i) => (
                  <tr
                    key={o.key}
                    className={clsx(
                      'border-b last:border-0 border-border',
                      i % 2 === 0 ? 'bg-card' : 'bg-muted/10',
                    )}
                  >
                    <td className="px-3 py-1.5 font-mono max-w-[200px] truncate" title={o.objectName}>
                      {o.objectName || <span className="text-muted italic">unnamed</span>}
                    </td>
                    <td className="px-3 py-1.5 text-muted">{o.objectType || '—'}</td>
                    <td className="px-3 py-1.5 text-muted max-w-[120px] truncate" title={o.toolName}>
                      {o.toolName || '—'}
                    </td>
                    <td className="px-3 py-1.5 text-muted max-w-[140px] truncate" title={o.connectionName}>
                      {o.connectionName || '—'}
                    </td>
                    <td className="px-3 py-1.5 text-muted max-w-[120px] truncate" title={o.databaseName}>
                      {o.databaseName || '—'}
                    </td>
                    <td className="px-3 py-1.5">
                      <span className={clsx('badge', badgeClass(o.source))}>
                        {badgeLabel(o.source)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {filtered.length === 0 && (
            <p className="text-xs text-muted text-center py-4">No orphans in this category.</p>
          )}
        </div>
      )}

      {allOrphans.length === 0 && scanStatus !== 'scanning' && (
        <div className="surface-card p-8 text-center">
          <p className="text-sm text-muted">No orphaned objects found in the current scan.</p>
          {scanStatus === 'idle' && (
            <p className="text-xs text-muted mt-1">Run a scan to check a larger portion of the catalog.</p>
          )}
        </div>
      )}
    </div>
  )
}
