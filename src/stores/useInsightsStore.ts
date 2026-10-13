import { create } from 'zustand'
import type { FathomInsights, DeepOrphanEntry, DeepScanProgress } from '../logic/types.ts'
import type { ScanMode } from '../logic/orphanScan.ts'
import type { AssetItem } from '@adamscloudera/octopai-api'

export type ScanStatus = 'idle' | 'scanning' | 'done' | 'error'

type InsightsState = {
  insights: FathomInsights | null
  rawAssets: AssetItem[]
  scanOrphans: DeepOrphanEntry[] | null
  scanProgress: DeepScanProgress | null
  scanStatus: ScanStatus
  scanError: string | null
  scanMode: ScanMode | null
  setInsights: (insights: FathomInsights) => void
  setRawAssets: (assets: AssetItem[]) => void
  clearInsights: () => void
  setScanOrphans: (orphans: DeepOrphanEntry[]) => void
  setScanProgress: (p: DeepScanProgress | null) => void
  setScanStatus: (s: ScanStatus, error?: string | null) => void
  setScanMode: (m: ScanMode | null) => void
}

let _initialInsights: FathomInsights | null = null
try { const _s = localStorage.getItem('fathom:insights'); if (_s) _initialInsights = JSON.parse(_s) } catch (_) {}

let _initialScanOrphans: DeepOrphanEntry[] | null = null
try { const _s = localStorage.getItem('fathom:scanOrphans'); if (_s) _initialScanOrphans = JSON.parse(_s) } catch (_) {}

let _initialScanStatus: ScanStatus = 'idle'
try { const _s = localStorage.getItem('fathom:scanStatus'); if (_s === 'done') _initialScanStatus = 'done' } catch (_) {}

let _initialScanMode: ScanMode | null = null
try { const _s = localStorage.getItem('fathom:scanMode'); if (_s === 'deep' || _s === 'quick') _initialScanMode = _s } catch (_) {}

export const useInsightsStore = create<InsightsState>((set) => ({
  insights: _initialInsights,
  rawAssets: [],
  scanOrphans: _initialScanOrphans,
  scanProgress: null,
  scanStatus: _initialScanStatus,
  scanError: null,
  scanMode: _initialScanMode,
  setInsights: (insights) => {
    set({ insights })
    try { localStorage.setItem('fathom:insights', JSON.stringify(insights)) } catch (_) {}
  },
  setRawAssets: (rawAssets) => set({ rawAssets }),
  clearInsights: () => {
    try { ['fathom:insights', 'fathom:scanOrphans', 'fathom:scanStatus', 'fathom:scanMode'].forEach(k => localStorage.removeItem(k)) } catch (_) {}
    set({
      insights: null,
      rawAssets: [],
      scanOrphans: null,
      scanProgress: null,
      scanStatus: 'idle',
      scanError: null,
      scanMode: null,
    })
  },
  setScanOrphans: (scanOrphans) => {
    set({ scanOrphans })
    try { localStorage.setItem('fathom:scanOrphans', JSON.stringify(scanOrphans)) } catch (_) {}
  },
  setScanProgress: (scanProgress) => set({ scanProgress }),
  setScanStatus: (scanStatus, error = null) => {
    if (scanStatus === 'done') {
      try { localStorage.setItem('fathom:scanStatus', 'done') } catch (_) {}
    }
    set({ scanStatus, scanError: error })
  },
  setScanMode: (scanMode) => {
    set({ scanMode })
    try {
      if (scanMode) localStorage.setItem('fathom:scanMode', scanMode)
      else localStorage.removeItem('fathom:scanMode')
    } catch (_) {}
  },
}))
