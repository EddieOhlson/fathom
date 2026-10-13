import { useRef } from 'react'
import { octopai } from '../logic/octopaiApi.ts'
import { selectSampleKeys, analyze, buildCatalogStats } from '../logic/analyzer.ts'
import type { AssetItem } from '@adamscloudera/octopai-api'
import type { LineageResult, LineageDashboard } from '../logic/types.ts'
import { useSessionStore } from '../stores/useSessionStore.ts'
import { useInsightsStore } from '../stores/useInsightsStore.ts'

const CONCURRENCY = 10

export function useAnalysis() {
  const analyzeAbortRef = useRef<AbortController | null>(null)
  const { company, accessToken, setStatus, setScanProgress } = useSessionStore()
  const { setInsights, setRawAssets, setPartialCatalogStats, clearInsights } = useInsightsStore()

  async function runAnalysis() {
    if (!accessToken) return
    clearInsights()
    analyzeAbortRef.current?.abort()
    const controller = new AbortController()
    analyzeAbortRef.current = controller

    const catalogStart = Date.now()
    setStatus('scanning', null)
    setScanProgress({ phase: 'catalog', done: 0, total: 0, startedAt: catalogStart })

    let assets: AssetItem[] = []
    const assetsSoFar: AssetItem[] = []
    try {
      assets = await octopai.queryAllAssets(
        company,
        accessToken,
        (fetched, pageItems) => {
          setScanProgress({ phase: 'catalog', done: fetched, total: 0, startedAt: catalogStart })
          // Progressive loading: recompute the cheap catalog-only stats on every
          // page so the dashboard can show live, growing numbers during the
          // fetch instead of a bare progress bar. These are exact counts over
          // whatever has landed so far, not a sample -- they just converge as
          // more pages arrive, same as the final numbers will be.
          assetsSoFar.push(...pageItems)
          setPartialCatalogStats({ ...buildCatalogStats(assetsSoFar), totalAssets: assetsSoFar.length })
        },
        controller.signal,
      )
    } catch (err) {
      if (controller.signal.aborted) { setScanProgress(null); return }
      const msg = err instanceof Error ? err.message : String(err)
      setScanProgress(null)
      setStatus('error', msg)
      return
    }

    if (controller.signal.aborted || analyzeAbortRef.current !== controller) {
      setScanProgress(null)
      return
    }

    const catalogPhaseDurationMs = Date.now() - catalogStart
    const toolCount = new Set(assets.map((a) => a.toolName ?? 'UNK')).size
    // Scale sample count: at least 20 per tool or 2% of catalog, whichever is larger, capped at 500.
    const targetSamples = Math.min(500, Math.max(toolCount * 20, Math.ceil(assets.length * 0.02)))
    const sampleKeys = selectSampleKeys(assets, targetSamples)
    const lineageStart = Date.now()
    setStatus('sampling', null)
    setScanProgress({ phase: 'lineage', done: 0, total: sampleKeys.length, startedAt: lineageStart })

    const lineageResults: LineageResult[] = []
    let completed = 0

    for (let batch = 0; batch < sampleKeys.length; batch += CONCURRENCY) {
      if (controller.signal.aborted || analyzeAbortRef.current !== controller) break
      const chunk = sampleKeys.slice(batch, batch + CONCURRENCY)
      const settled = await Promise.allSettled(
        chunk.map((key) =>
          octopai.queryLineage(company, accessToken, key, 2, controller.signal).then((raw) => ({
            key,
            raw,
          }))
        )
      )
      for (const r of settled) {
        if (r.status === 'fulfilled') {
          const { key, raw } = r.value
          lineageResults.push({
            queryKey: key,
            nodes: (raw.nodes ?? []) as LineageResult['nodes'],
            edges: raw.links ?? [],
          })
        }
      }
      completed += chunk.length
      setScanProgress({ phase: 'lineage', done: completed, total: sampleKeys.length, startedAt: lineageStart })
    }

    if (controller.signal.aborted || analyzeAbortRef.current !== controller) {
      setScanProgress(null)
      return
    }

    const lineagePhaseDurationMs = Date.now() - lineageStart

    // Phase 3: read Cross System Lineage Dashboard counts via internal API
    setScanProgress({ phase: 'dashboard', done: 0, total: 3, startedAt: Date.now() })

    let lineageDashboard: LineageDashboard | null = null
    let columnDashboard: LineageDashboard | null = null
    const connectionIds = [...new Set(
      assets.map((a) => a.connectionId).filter((id): id is string => Boolean(id))
    )]

    if (!controller.signal.aborted && analyzeAbortRef.current === controller) {
      const [etlRes, dbRes, reportRes, colEtlRes, colDbRes, colReportRes] = await Promise.allSettled([
        octopai.queryLineageDashboard(company, accessToken, connectionIds, 'ETL', controller.signal),
        octopai.queryLineageDashboard(company, accessToken, connectionIds, 'DB', controller.signal),
        octopai.queryLineageDashboard(company, accessToken, connectionIds, 'REPORT', controller.signal),
        octopai.queryColumnDashboard(company, accessToken, connectionIds, 'ETL', controller.signal),
        octopai.queryColumnDashboard(company, accessToken, connectionIds, 'DB', controller.signal),
        octopai.queryColumnDashboard(company, accessToken, connectionIds, 'REPORT', controller.signal),
      ])

      if (
        etlRes.status === 'fulfilled' &&
        dbRes.status === 'fulfilled' &&
        reportRes.status === 'fulfilled'
      ) {
        lineageDashboard = {
          etl: { total: etlRes.value.total?.ETL ?? 0, byTool: etlRes.value.total?.etldetails ?? {} },
          db: { total: dbRes.value.total?.DB ?? 0, byTool: dbRes.value.total?.DBdetails ?? {} },
          report: { total: reportRes.value.total?.REPORT ?? 0, byTool: reportRes.value.total?.REPORTDETAILS ?? {} },
        }
      }

      if (
        colEtlRes.status === 'fulfilled' &&
        colDbRes.status === 'fulfilled' &&
        colReportRes.status === 'fulfilled'
      ) {
        columnDashboard = {
          etl: { total: colEtlRes.value.total ?? 0, byTool: colEtlRes.value.details ?? {} },
          db: { total: colDbRes.value.total ?? 0, byTool: colDbRes.value.details ?? {} },
          report: { total: colReportRes.value.total ?? 0, byTool: colReportRes.value.details ?? {} },
        }
      }
    }

    setScanProgress(null)

    const insights = analyze(
      company,
      assets,
      lineageResults,
      catalogPhaseDurationMs,
      lineagePhaseDurationMs,
      new Date().toISOString(),
      lineageDashboard,
      columnDashboard,
    )
    setRawAssets(assets)
    setInsights(insights)
    setStatus('done', null)
  }

  function cancelAnalysis() {
    analyzeAbortRef.current?.abort()
  }

  return { runAnalysis, cancelAnalysis }
}
