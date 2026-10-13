import { useState, useEffect } from 'react'
import { Plug, LogOut, Search, AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react'
import { clsx } from 'clsx'
import { octopai } from '../logic/octopaiApi.ts'
import { useSessionStore } from '../stores/useSessionStore.ts'
import { useInsightsStore } from '../stores/useInsightsStore.ts'
import { useAnalysis } from '../hooks/useAnalysis.ts'
import { PartialCatalogCard } from './PartialCatalogCard.tsx'

function TokenExpiry({ expiry }: { expiry: string }) {
  if (!expiry) return null
  const ms = new Date(expiry).getTime() - Date.now()
  if (ms <= 0) return <span className="text-xs text-red-500">Token expired</span>
  const mins = Math.round(ms / 60000)
  if (mins < 60) return <span className="text-xs text-amber-600">Token expires in {mins}m</span>
  const hrs = Math.round(ms / 3600000)
  return <span className="text-xs text-muted">Token expires in {hrs}h</span>
}

export function LoginPanel() {
  const {
    company, accessToken, accessExpiry, displayName, status, error,
    scanProgress, setConfig, setTokens, setStatus, clearSession,
  } = useSessionStore()
  const { clearInsights, partialCatalogStats } = useInsightsStore()
  const { runAnalysis, cancelAnalysis } = useAnalysis()

  const [companyInput, setCompanyInput] = useState(company)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!scanProgress) { setElapsed(0); return }
    const { startedAt } = scanProgress
    setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(id)
  }, [scanProgress?.startedAt])

  const isConnected = !!accessToken
  const isBusy = status === 'connecting' || status === 'scanning' || status === 'sampling'

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault()
    if (!companyInput.trim() || !email.trim() || !password.trim()) return
    setConfig(companyInput.trim())
    setStatus('connecting', null)
    try {
      const resp = await octopai.login(companyInput.trim(), email, password)
      setTokens({
        accessToken: resp.accessToken,
        accessExpiry: resp.expiration,
        displayName: resp.displayName || resp.userName,
      })
      setPassword('')
    } catch (err) {
      setStatus('error', err instanceof Error ? err.message : String(err))
    }
  }

  function handleDisconnect() {
    cancelAnalysis()
    clearSession()
    clearInsights()
  }

  if (!isConnected) {
    return (
      <div className="surface-card p-6 space-y-5">
        <div>
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <Plug className="w-4 h-4 text-primary" />
            Connect to a tenant
          </h2>
          <p className="mt-1 text-sm text-muted">
            Enter your Octopai tenant and credentials to pull a full catalog scan and lineage sample.
          </p>
        </div>

        <form onSubmit={handleConnect} className="space-y-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted">Company name</label>
            <div className="flex items-center gap-1.5">
              <input
                type="text"
                value={companyInput}
                onChange={(e) => setCompanyInput(e.target.value)}
                placeholder="acme"
                className="flex-1 px-3 py-1.5 text-sm rounded-lg border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="text-xs text-muted whitespace-nowrap">.octopai.com</span>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@company.com"
              className="px-3 py-1.5 text-sm rounded-lg border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
              autoComplete="email"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="px-3 py-1.5 text-sm rounded-lg border border-border bg-card focus:outline-none focus:ring-2 focus:ring-primary/30"
              autoComplete="current-password"
            />
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={isBusy || !companyInput.trim() || !email.trim() || !password.trim()}
              className="btn-primary"
            >
              {status === 'connecting' ? (
                <RefreshCw className="w-4 h-4 animate-spin" />
              ) : (
                <Plug className="w-4 h-4" />
              )}
              {status === 'connecting' ? 'Connecting…' : 'Connect'}
            </button>
          </div>

          {status === 'error' && error && (
            <p className="flex items-start gap-2 text-xs text-red-600">
              <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
              {error}
            </p>
          )}
        </form>
      </div>
    )
  }

  return (
    <div className="surface-card p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-green-50 border border-green-200">
          <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
          <div>
            <p className="text-sm font-medium text-foreground">{displayName}</p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted">{company}.octopai.com</span>
              <TokenExpiry expiry={accessExpiry} />
            </div>
          </div>
        </div>

        <button
          onClick={runAnalysis}
          disabled={isBusy}
          className={clsx('btn-primary', status === 'done' && 'opacity-80')}
        >
          {isBusy ? (
            <RefreshCw className="w-4 h-4 animate-spin" />
          ) : (
            <Search className="w-4 h-4" />
          )}
          {status === 'scanning' ? 'Scanning catalog…'
            : status === 'sampling' ? 'Sampling lineage…'
            : status === 'done' ? 'Re-analyze'
            : 'Analyze'}
        </button>

        <button onClick={handleDisconnect} disabled={isBusy} className="btn-ghost">
          <LogOut className="w-4 h-4" />
          Disconnect
        </button>
      </div>

      {scanProgress && (
        <div className="space-y-1.5 p-3 rounded-lg bg-muted/20 border border-border/60">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted">
              {scanProgress.phase === 'catalog'
                ? scanProgress.done > 0
                  ? `Catalog: ${scanProgress.done.toLocaleString()} objects fetched…`
                  : 'Fetching catalog…'
                : scanProgress.phase === 'lineage'
                ? `Lineage sample: ${scanProgress.done} / ${scanProgress.total}`
                : 'Reading lineage dashboard…'}
            </span>
            <span className="font-mono text-muted tabular-nums">{elapsed}s</span>
          </div>
          <div className="h-1.5 rounded-full bg-border overflow-hidden">
            {scanProgress.phase === 'lineage' && scanProgress.total > 0 ? (
              <div
                className="h-full rounded-full bg-primary/60 transition-all duration-300"
                style={{ width: `${Math.round((scanProgress.done / scanProgress.total) * 100)}%` }}
              />
            ) : (
              <div className="h-full rounded-full bg-primary/60 animate-pulse w-full" />
            )}
          </div>
        </div>
      )}

      {status === 'error' && error && (
        <p className="flex items-start gap-2 text-xs text-red-600">
          <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
          {error}
        </p>
      )}

      {isBusy && partialCatalogStats && <PartialCatalogCard stats={partialCatalogStats} />}
    </div>
  )
}
