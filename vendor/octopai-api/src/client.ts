import type {
  LoginResponse,
  AssetsQueryResponse,
  AssetItem,
  LineageNode,
  LineageResponse,
  LineageDashboardResponse,
  ColumnDashboardResponse,
} from './types.ts'

export type OctopaiClient = {
  login(company: string, username: string, password: string): Promise<LoginResponse>
  queryAssets(company: string, token: string, limit?: number, signal?: AbortSignal): Promise<AssetsQueryResponse>
  queryAllAssets(
    company: string,
    token: string,
    onProgress?: (fetched: number, pageItems: AssetItem[]) => void,
    signal?: AbortSignal,
  ): Promise<AssetItem[]>
  // Fetch a small batch (200) for building the connectionName → connectionId index.
  queryAssetsForIndex(company: string, token: string, signal?: AbortSignal): Promise<AssetItem[]>
  // Fetch assets scoped to a single connection by its numeric Octopai connectionId.
  queryAssetsForConnection(company: string, token: string, connectionId: string, signal?: AbortSignal): Promise<AssetItem[]>
  // Fetch all assets (up to DEFAULT_PAGE_SIZE) for a single connection — used for enrichment.
  queryAllAssetsForConnection(company: string, token: string, connectionId: string, signal?: AbortSignal): Promise<AssetItem[]>
  queryLineage(
    company: string,
    token: string,
    assetKey: string,
    depth?: number,
    signal?: AbortSignal,
    direction?: number,
  ): Promise<LineageResponse>
  // Calls the internal GetMainScreenItems endpoint (Cross System Lineage Dashboard backing API).
  queryLineageDashboard(
    company: string,
    token: string,
    connections: string[],
    type: 'ETL' | 'DB' | 'REPORT',
    signal?: AbortSignal,
  ): Promise<LineageDashboardResponse>
  // Calls the internal E2EMainItems endpoint (E2E Column Dashboard backing API).
  queryColumnDashboard(
    company: string,
    token: string,
    connections: string[],
    type: 'ETL' | 'DB' | 'REPORT',
    signal?: AbortSignal,
  ): Promise<ColumnDashboardResponse>
  // Calls the internal GetLinage endpoint to fetch full object details by GUID.
  // Used to enrich lineage nodes that lack objectName in the v2.0 API response.
  queryObjectDetails(
    company: string,
    token: string,
    guid: string,
    connections: string[],
    signal?: AbortSignal,
  ): Promise<{ name: string; objectType: string } | null>
  // Fetch all column-level assets (assetType: 1, IsMap: false) with scroll pagination.
  queryAllColumnAssets(
    company: string,
    token: string,
    onProgress?: (fetched: number) => void,
    signal?: AbortSignal,
  ): Promise<AssetItem[]>
  // Server-side name-filtered asset search: POST /assets/query with AssetNames filter.
  queryAssetsByName(
    company: string,
    token: string,
    names: string[],
    signal?: AbortSignal,
  ): Promise<AssetItem[]>
}

const REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_PAGE_SIZE = 10_000

// Merge an external AbortSignal into a locally-owned controller so a single
// controller can gate both timeout and caller-initiated cancellation.
function linkSignal(controller: AbortController, external?: AbortSignal): void {
  if (!external) return
  if (external.aborted) { controller.abort(external.reason); return }
  external.addEventListener('abort', () => controller.abort(external.reason), { once: true })
}

export function createOctopaiClient(proxyBase: string): OctopaiClient {
  // All requests route through the caller-supplied proxy base.
  // Production: nginx proxy_pass; development: Vite proxy config.
  function proxyUrl(path: string): string {
    return `${proxyBase}${path}`
  }

  async function apiPost<T>(
    company: string,
    path: string,
    body: unknown,
    token?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Octopai-Host': `${company}.octopai.com`,
    }
    if (token) headers['Authorization'] = `Bearer ${token}`

    const controller = new AbortController()
    linkSignal(controller, signal)
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const res = await fetch(proxyUrl(path), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
      }
      const data = await res.json() as T
      return data
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') {
        if (signal?.aborted) throw new Error('Request cancelled.')
        throw new Error(
          `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s — Octopai did not respond. ` +
          `The tenant may be unavailable or the query returned too many assets.`,
        )
      }
      if (err instanceof TypeError) throw new Error('Network error — could not reach the proxy.')
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  async function login(company: string, username: string, password: string): Promise<LoginResponse> {
    const data = await apiPost<LoginResponse>(company, '/api/UserAccount/Login', {
      Username: username,
      Password: password,
    })
    if (data.error) throw new Error(data.error)
    return data
  }

  // The API returns connLogicName/tableName; normalize to the AssetItem contract.
  // Different Octopai tenants/versions use different casings — try all known variants.
  function normalizeItem(raw: Record<string, unknown>): AssetItem {
    const rawGuid = raw.objectGUID ?? raw.ObjectGUID ?? raw.objectguid
    const rawConnId = raw.connectionId ?? raw.ConnectionId ?? raw.connectionID ?? raw.CONNECTIONID
    const rawAssetName = raw.assetName ?? raw.AssetName ?? raw.columnName ?? raw.ColumnName
    const rawDataType = raw.dataType ?? raw.DataType ?? raw.data_type
    return {
      ...(raw as AssetItem),
      connectionName: String(
        raw.connLogicName ??
        raw.ConnLogicName ??
        raw.connectionLogicName ??
        raw.ConnectionLogicName ??
        raw.connectionName ??
        raw.ConnectionName ??
        '',
      ),
      objectName: String(raw.tableName ?? raw.TableName ?? raw.objectName ?? raw.ObjectName ?? ''),
      objectGUID: typeof rawGuid === 'string' && rawGuid ? rawGuid : undefined,
      connectionId: typeof rawConnId === 'string' || typeof rawConnId === 'number'
        ? String(rawConnId)
        : undefined,
      assetName: typeof rawAssetName === 'string' && rawAssetName ? rawAssetName : undefined,
      dataType: typeof rawDataType === 'string' && rawDataType ? rawDataType : undefined,
    }
  }

  function normalizeResponse(resp: AssetsQueryResponse): AssetsQueryResponse {
    return { ...resp, items: resp.items.map(normalizeItem) }
  }

  async function queryAssets(
    company: string,
    token: string,
    limit = DEFAULT_PAGE_SIZE,
    signal?: AbortSignal,
  ): Promise<AssetsQueryResponse> {
    const resp = await apiPost<AssetsQueryResponse>(
      company,
      '/api/v2.0/assets/query',
      { limit, assetType: 2 },
      token,
      signal,
    )
    return normalizeResponse(resp)
  }

  async function queryAllAssets(
    company: string,
    token: string,
    onProgress?: (fetched: number, pageItems: AssetItem[]) => void,
    signal?: AbortSignal,
  ): Promise<AssetItem[]> {
    const all: AssetItem[] = []
    let offset = 0
    while (true) {
      if (signal?.aborted) throw new Error('Asset fetch cancelled.')
      const resp = await apiPost<AssetsQueryResponse>(
        company,
        '/api/v2.0/assets/query',
        { limit: DEFAULT_PAGE_SIZE, offset, assetType: 2 },
        token,
        signal,
      )
      const page = normalizeResponse(resp)
      all.push(...page.items)
      onProgress?.(all.length, page.items)
      if (page.items.length < DEFAULT_PAGE_SIZE) break
      offset += DEFAULT_PAGE_SIZE
    }
    return all
  }

  async function queryAssetsForIndex(
    company: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<AssetItem[]> {
    const resp = await queryAssets(company, token, 200, signal)
    return resp.items
  }

  async function queryAssetsForConnection(
    company: string,
    token: string,
    connectionId: string,
    signal?: AbortSignal,
  ): Promise<AssetItem[]> {
    const resp = await apiPost<AssetsQueryResponse>(
      company,
      '/api/v2.0/assets/query',
      { limit: 50, assetType: 2, ConnectionIds: [connectionId] },
      token,
      signal,
    )
    return normalizeResponse(resp).items
  }

  async function queryAllAssetsForConnection(
    company: string,
    token: string,
    connectionId: string,
    signal?: AbortSignal,
  ): Promise<AssetItem[]> {
    const resp = await apiPost<AssetsQueryResponse>(
      company,
      '/api/v2.0/assets/query',
      { limit: DEFAULT_PAGE_SIZE, assetType: 2, ConnectionIds: [connectionId] },
      token,
      signal,
    )
    return normalizeResponse(resp).items
  }

  function normalizeLineageResponse(resp: LineageResponse): LineageResponse {
    const rawEdges = (
      (resp as unknown as Record<string, unknown>).edges ??
      resp.links ??
      []
    ) as unknown as Array<Record<string, unknown>>
    return {
      ...resp,
      nodes: (resp.nodes ?? []).map((n) => normalizeItem(n as Record<string, unknown>) as LineageNode),
      links: rawEdges.map((l) => ({
        from: String(l.from ?? l._from ?? ''),
        to: String(l.to ?? l._to ?? ''),
        type: l.type as string | undefined,
      })),
    }
  }

  async function queryLineage(
    company: string,
    token: string,
    assetKey: string,
    depth = 2,
    signal?: AbortSignal,
    direction = 2,
  ): Promise<LineageResponse> {
    const resp = await apiPost<LineageResponse>(
      company,
      '/api/v2.0/lineage',
      { assetKey, depth, limit: 5000, assetType: 2, direction },
      token,
      signal,
    )
    return normalizeLineageResponse(resp)
  }

  async function queryLineageDashboard(
    company: string,
    token: string,
    connections: string[],
    type: 'ETL' | 'DB' | 'REPORT',
    signal?: AbortSignal,
  ): Promise<LineageDashboardResponse> {
    return apiPost<LineageDashboardResponse>(
      company,
      '/api/lineage/GetMainScreenItems',
      {
        connections,
        mainSearch: '',
        searches: [{ type, filter: '', from: 0 }],
      },
      token,
      signal,
    )
  }

  async function queryColumnDashboard(
    company: string,
    token: string,
    connections: string[],
    type: 'ETL' | 'DB' | 'REPORT',
    signal?: AbortSignal,
  ): Promise<ColumnDashboardResponse> {
    return apiPost<ColumnDashboardResponse>(
      company,
      '/api/lineage/E2EMainItems',
      {
        connections,
        type,
        mainSearch: '',
        filters: null,
        from: 0,
        innerSearch: '',
        sort: '',
      },
      token,
      signal,
    )
  }

  async function queryObjectDetails(
    company: string,
    token: string,
    guid: string,
    connections: string[],
    signal?: AbortSignal,
  ): Promise<{ name: string; objectType: string } | null> {
    type GetLinageResponse = {
      nodes?: Array<{
        name?: string
        type?: string
        properties?: { ObjectName?: string; ObjectType?: string }
      }>
    }
    const resp = await apiPost<GetLinageResponse>(
      company,
      '/api/lineage/GetLinage',
      { rid: guid, connections },
      token,
      signal,
    )
    const node = resp.nodes?.[0]
    if (!node) return null
    const name = node.name || node.properties?.ObjectName || ''
    const objectType = node.type || node.properties?.ObjectType || ''
    return name ? { name, objectType } : null
  }

  async function queryAllColumnAssets(
    company: string,
    token: string,
    onProgress?: (fetched: number) => void,
    signal?: AbortSignal,
  ): Promise<AssetItem[]> {
    const all: AssetItem[] = []
    let offset = 0
    while (true) {
      if (signal?.aborted) throw new Error('Column asset fetch cancelled.')
      const resp = await apiPost<AssetsQueryResponse>(
        company,
        '/api/v2.0/assets/query',
        { limit: DEFAULT_PAGE_SIZE, offset, assetType: 1, IsMap: false },
        token,
        signal,
      )
      const page = normalizeResponse(resp)
      all.push(...page.items)
      onProgress?.(all.length)
      if (page.items.length < DEFAULT_PAGE_SIZE) break
      offset += DEFAULT_PAGE_SIZE
    }
    return all
  }

  async function queryAssetsByName(
    company: string,
    token: string,
    names: string[],
    signal?: AbortSignal,
  ): Promise<AssetItem[]> {
    const all: AssetItem[] = []
    let offset = 0
    while (true) {
      if (signal?.aborted) throw new Error('Asset name search cancelled.')
      const resp = await apiPost<AssetsQueryResponse>(
        company,
        '/api/v2.0/assets/query',
        { AssetNames: names, assetType: 2, limit: DEFAULT_PAGE_SIZE, offset },
        token,
        signal,
      )
      const page = normalizeResponse(resp)
      all.push(...page.items)
      if (page.items.length < DEFAULT_PAGE_SIZE) break
      offset += DEFAULT_PAGE_SIZE
    }
    return all
  }

  return {
    login,
    queryAssets,
    queryAllAssets,
    queryAssetsForIndex,
    queryAssetsForConnection,
    queryAllAssetsForConnection,
    queryLineage,
    queryLineageDashboard,
    queryColumnDashboard,
    queryObjectDetails,
    queryAllColumnAssets,
    queryAssetsByName,
  }
}
