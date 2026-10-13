import type { AssetItem } from '@adamscloudera/octopai-api'
import { octopai } from './octopaiApi.ts'
import type { DeepOrphanEntry } from './types.ts'

const CONCURRENCY = 10

// Cap to keep scan time reasonable on large catalogs.
// At concurrency=10, ~1s/call: 2000 objects ≈ 3-4 minutes.
export const DEEP_SCAN_MAX = 2000

// Quick scan checks a random slice of the same candidate pool, for a fast
// representative read instead of the full run.
export const QUICK_SCAN_FRACTION = 0.3

export type ScanMode = 'deep' | 'quick'

// Only scan DB (tables/views) and ETL (pipeline jobs) — reports are terminal nodes
// by definition and will never have downstream connections.
// Deduplicate by objectName+connectionName: a column-level catalog has N rows per table;
// querying all N would repeat the same lineage check N times for the same underlying object.
function dedupedCandidates(assets: AssetItem[]): AssetItem[] {
  const seen = new Set<string>()
  const candidates: AssetItem[] = []
  for (const a of assets) {
    if (a.toolType !== 'DB' && a.toolType !== 'ETL') continue
    const tableKey = `${a.connectionName ?? ''}||${a.objectName ?? ''}`
    if (seen.has(tableKey)) continue
    seen.add(tableKey)
    candidates.push(a)
    if (candidates.length >= DEEP_SCAN_MAX) break
  }
  return candidates
}

// Deep: the full deduped pool. Quick: a fresh random 30% slice of that same
// pool each call — no seed, so repeated quick scans gradually cover more of
// the catalog without committing to a full deep scan.
export function selectScanCandidates(assets: AssetItem[], mode: ScanMode): AssetItem[] {
  const deduped = dedupedCandidates(assets)
  if (mode === 'deep') return deduped
  const sampleSize = Math.round(deduped.length * QUICK_SCAN_FRACTION)
  const shuffled = [...deduped].sort(() => Math.random() - 0.5)
  return shuffled.slice(0, sampleSize)
}

export function estimateScanSeconds(assets: AssetItem[], mode: ScanMode): number {
  return Math.ceil(selectScanCandidates(assets, mode).length / CONCURRENCY)
}

export async function runOrphanScan(
  mode: ScanMode,
  company: string,
  accessToken: string,
  assets: AssetItem[],
  onProgress: (done: number, total: number) => void,
  signal: AbortSignal,
): Promise<DeepOrphanEntry[]> {
  const candidates = selectScanCandidates(assets, mode)
  const total = candidates.length
  let done = 0
  const orphans: DeepOrphanEntry[] = []

  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    if (signal.aborted) break
    const batch = candidates.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(
      batch.map((asset) =>
        // direction: 0 = bidirectional; depth: 1 = one hop is enough to confirm any connection.
        // A true orphan has zero edges in either direction.
        octopai.queryLineage(company, accessToken, asset._key, 1, signal, 0).then((r) => ({
          asset,
          links: r.links ?? [],
        })),
      ),
    )
    for (const r of results) {
      if (r.status !== 'fulfilled') continue
      const { asset, links } = r.value
      if (links.length === 0) {
        orphans.push({
          key: asset._key,
          objectName: asset.objectName ?? '',
          connectionName: asset.connectionName ?? '',
          databaseName: asset.databaseName ?? '',
          schemaName: asset.schemaName ?? '',
          objectType: asset.objectType ?? '',
          toolName: asset.toolName ?? '',
          toolType: asset.toolType ?? '',
          source: mode,
        })
      }
    }
    done += batch.length
    onProgress(done, total)
  }

  return orphans
}
