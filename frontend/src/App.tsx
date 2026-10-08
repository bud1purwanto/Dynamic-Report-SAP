import { useEffect, useMemo, useRef, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import type { ColDef } from 'ag-grid-community'
import { ReactFlow, Background, Controls, Handle, MarkerType, Position, useNodesState, useUpdateNodeInternals } from '@xyflow/react'
import type { Connection, Node, NodeProps, ReactFlowInstance } from '@xyflow/react'
import {
  AlertTriangle, ArrowRight, BarChart3, ChevronDown, Columns3, CopyPlus, Database, Download,
  GitCompareArrows, KeyRound, Layers3, LogOut, Play, Plus, Save, Search,
  Settings2, ShieldCheck, Table2, Trash2, WandSparkles, X,
} from 'lucide-react'
import { api, post } from './api'
import type { GridData, Join, JoinCondition, Query, Row, Server, Source } from './api'

type User = { id?: string; username?: string; email?: string; roles?: string[] }
type Report = { id: string; name: string; definition: Query }
type Credential = { connectionId: string; target?: string; hasCredential: boolean; username?: string }
type Variant = { id: string; name: string; layout: {
  columns: string[]
  columnState?: ReturnType<NonNullable<AgGridReact<Row>['api']>['getColumnState']>
  filterModel?: ReturnType<NonNullable<AgGridReact<Row>['api']>['getFilterModel']>
} }
type Tab = 'builder' | 'compare' | 'credentials' | 'ai' | 'schedules'
type Schedule = { id: string; report_id: string; interval_minutes: number;
  enabled: boolean; next_run_at: string; last_run_at: string | null; last_status: string | null; last_error: string | null }
type ReportRun = { id: string; report_id: string | null; status: string; row_count: number; has_artifact: boolean;
  error: string | null; started_at: string }
type StructureField = { name: string; is_key: boolean; data_type: string; check_table?: string }
type TableNodeData = Record<string, unknown> & {
  alias: string
  tableName: string
  fields: StructureField[]
  loading: boolean
  joinedFields?: string[]
}
type TableFlowNode = Node<TableNodeData, 'table'>

function TableNode({ id, data }: NodeProps<TableFlowNode>) {
  const updateNodeInternals = useUpdateNodeInternals()
  const [search, setSearch] = useState('')

  const joinedSet = useMemo(() => new Set(data.joinedFields || []), [data.joinedFields])

  const { pinnedFields, otherFields } = useMemo(() => {
    const pinned: StructureField[] = []
    const others: StructureField[] = []
    const term = search.trim().toUpperCase()

    for (const f of data.fields) {
      if (joinedSet.has(f.name)) {
        pinned.push(f)
      } else if (!term || f.name.toUpperCase().includes(term) || f.data_type.toUpperCase().includes(term)) {
        others.push(f)
      }
    }
    return { pinnedFields: pinned, otherFields: others }
  }, [data.fields, joinedSet, search])

  useEffect(() => {
    updateNodeInternals(id)
  }, [id, data.joinedFields, data.fields, updateNodeInternals])

  return <div className="table-node">
    <div className="table-node-header"><Table2 size={16} /><div><strong>{data.tableName || 'Pilih tabel'}</strong><small>{data.alias} · {data.fields.length} kolom</small></div></div>
    {data.fields.length > 6 && <div className="table-node-search-wrap nodrag"><Search size={12} />
      <input className="table-node-search" placeholder="Cari field…" value={search} onChange={e => setSearch(e.target.value)} /></div>}
    {pinnedFields.length > 0 && <div className="table-node-pinned">
      <div className="table-node-section-label">Field Terhubung</div>
      {pinnedFields.map(field => <div className="table-node-field is-joined" key={field.name}>
        <Handle type="target" position={Position.Left} id={field.name} />
        <span>{field.is_key ? '◆ ' : ''}{field.name}</span><small>{field.data_type}</small>
        <Handle type="source" position={Position.Right} id={field.name} />
      </div>)}
    </div>}
    <div className="table-node-fields nowheel nodrag" onScroll={() => updateNodeInternals(id)}>
      {otherFields.length ? otherFields.map(field => <div className="table-node-field" key={field.name}>
        <Handle type="target" position={Position.Left} id={field.name} />
        <span>{field.is_key ? '◆ ' : ''}{field.name}</span><small>{field.data_type}</small>
        <Handle type="source" position={Position.Right} id={field.name} />
      </div>) : pinnedFields.length > 0 && !search ? null : <div className="table-node-empty">{data.loading ? 'Memuat kolom…' : data.tableName ? (search ? 'Tidak ada field cocok' : 'Struktur belum tersedia') : 'Isi nama tabel'}</div>}
    </div>
  </div>
}

const nodeTypes = { table: TableNode }

function suggestedConditions(left: StructureField[], right: StructureField[]): JoinCondition[] {
  const rightByName = new Map(right.map(field => [field.name, field]))
  const shared = left.filter(field => field.name !== 'MANDT' && rightByName.has(field.name) &&
    (!field.data_type || !rightByName.get(field.name)?.data_type ||
      field.data_type.toUpperCase() === rightByName.get(field.name)?.data_type.toUpperCase()))
  const keys = shared.filter(field => field.is_key && rightByName.get(field.name)?.is_key)
  const candidates = keys.length ? keys : shared.filter(field => field.is_key || rightByName.get(field.name)?.is_key)
  const selected = candidates.length ? candidates : shared.length === 1 ? shared : []
  return selected.slice(0, 10).map(field => ({ left_field: field.name, right_field: field.name }))
}

const blankSource = (index: number): Source => ({
  alias: `T${index + 1}`, table_name: '', fields: [], filters: [],
})
const initialQuery: Query = { target: '', sources: [blankSource(0)], joins: [], rowcount: 100 }

function App() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [tab, setTab] = useState<Tab>('builder')
  const [servers, setServers] = useState<Server[]>([])
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [reports, setReports] = useState<Report[]>([])
  const [query, setQuery] = useState<Query>(initialQuery)
  const [data, setData] = useState<GridData>({ columns: [], rows: [] })
  const [loginName, setLoginName] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [reportName, setReportName] = useState('')
  const [activeReport, setActiveReport] = useState('')
  const [variantName, setVariantName] = useState('')
  const [variants, setVariants] = useState<Variant[]>([])
  const [visibleColumns, setVisibleColumns] = useState<string[]>([])
  const [pivotOpen, setPivotOpen] = useState(false)
  const [pivotIndex, setPivotIndex] = useState('')
  const [pivotColumn, setPivotColumn] = useState('')
  const [pivotValue, setPivotValue] = useState('')
  const [pivotAgg, setPivotAgg] = useState('first')
  const [formulaOpen, setFormulaOpen] = useState(false)
  const [formulaName, setFormulaName] = useState('')
  const [formulaExpression, setFormulaExpression] = useState('')
  const [otherTarget, setOtherTarget] = useState('')
  const [compareKeys, setCompareKeys] = useState('')
  const [changes, setChanges] = useState<{ key: Row; status: string; left: Row | null; right: Row | null }[]>([])
  const [credTarget, setCredTarget] = useState('')
  const [sapUsername, setSapUsername] = useState('')
  const [sapPassword, setSapPassword] = useState('')
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiDraft, setAiDraft] = useState<{ query: Query; explanation: string } | null>(null)
  const [aiModel, setAiModel] = useState('')
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [runs, setRuns] = useState<ReportRun[]>([])
  const [scheduleReport, setScheduleReport] = useState('')
  const [scheduleInterval, setScheduleInterval] = useState(1440)
  const [structureText, setStructureText] = useState<Record<string, string>>({})
  const [structureFields, setStructureFields] = useState<Record<string, StructureField[]>>({})
  const [structureKeys, setStructureKeys] = useState<Record<string, string>>({})
  const [structureLoading, setStructureLoading] = useState<Record<string, boolean>>({})
  const [fieldSearch, setFieldSearch] = useState<Record<string, string>>({})
  const [fieldText, setFieldText] = useState<Record<string, string>>({})
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean
    title: string
    message: string
    confirmLabel?: string
    confirmTone?: 'danger' | 'primary'
    onConfirm: () => void
  }>({ open: false, title: '', message: '', onConfirm: () => {} })
  const gridRef = useRef<AgGridReact<Row>>(null)
  const flowRef = useRef<ReactFlowInstance<TableFlowNode> | null>(null)
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<TableFlowNode>([])

  function showConfirm(options: {
    title: string
    message: string
    confirmLabel?: string
    confirmTone?: 'danger' | 'primary'
    onConfirm: () => void
  }) {
    setConfirmModal({ open: true, ...options })
  }

  async function loadWorkspace() {
    const [catalog, saved, creds] = await Promise.allSettled([
      api<{ resources: Server[] }>('/sap/servers'),
      api<Report[]>('/reports'),
      api<Credential[]>('/sap/credentials'),
    ])
    if (catalog.status === 'fulfilled') {
      setServers(catalog.value.resources)
      setQuery(q => ({ ...q, target: q.target || catalog.value.resources[0]?.id || '' }))
      setCredTarget(t => t || catalog.value.resources[0]?.id || '')
      setOtherTarget(t => t || catalog.value.resources[1]?.id || '')
    }
    if (saved.status === 'fulfilled') {
      setReports(saved.value)
      setActiveReport(cur => saved.value.some(r => r.id === cur) ? cur : '')
    }
    if (creds.status === 'fulfilled') setCredentials(creds.value)
    const failed = [catalog, saved, creds].find(x => x.status === 'rejected')
    if (failed?.status === 'rejected') setError(message(failed.reason))
  }

  useEffect(() => {
    api<{ user: User }>('/auth/me')
      .then(r => { setUser(r.user); return loadWorkspace() })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const structureSignature = query.sources.map(source => `${source.alias}:${source.table_name}`).join('|')
  useEffect(() => {
    if (!query.target) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      query.sources.filter(source => /^[A-Z_][A-Z0-9_]{1,29}$/.test(source.table_name) &&
        structureKeys[source.alias] !== `${query.target}:${source.table_name}`).forEach(source => {
        const key = `${query.target}:${source.table_name}`
        setStructureLoading(current => ({ ...current, [source.alias]: true }))
        post<{ text: string; fields: StructureField[] }>('/sap/table-structure', {
          target: query.target, table_name: source.table_name,
        }).then(result => {
          if (cancelled) return
          setStructureFields(current => ({ ...current, [source.alias]: result.fields || [] }))
          setStructureText(current => ({ ...current, [source.alias]: result.fields?.length ? '' : result.text || 'Struktur tidak tersedia.' }))
          setStructureKeys(current => ({ ...current, [source.alias]: key }))
        }).catch(error => { if (!cancelled) setError(message(error)) })
          .finally(() => { if (!cancelled) setStructureLoading(current => ({ ...current, [source.alias]: false })) })
      })
    }, 450)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [structureSignature, query.target, structureKeys])

  useEffect(() => {
    setQuery(current => {
      let changed = false
      const joins = current.joins.map((join, index) => {
        if (join.manual || join.conditions?.length || (join.left_field && join.right_field)) return join
        const right = current.sources[index + 1]
        if (!right || structureKeys[right.alias] !== `${current.target}:${right.table_name}`) return join
        const candidates = current.sources.slice(0, index + 1).map(left => ({
          left,
          conditions: structureKeys[left.alias] === `${current.target}:${left.table_name}`
            ? suggestedConditions(structureFields[left.alias] || [], structureFields[right.alias] || []) : [],
        })).sort((a, b) => b.conditions.length - a.conditions.length)
        const best = candidates[0]
        if (!best?.conditions.length) return join
        changed = true
        return { ...join, left_alias: best.left.alias, conditions: best.conditions,
          left_field: best.conditions[0].left_field, right_field: best.conditions[0].right_field }
      })
      return changed ? { ...current, joins } : current
    })
  }, [query.sources, structureFields, structureKeys])

  useEffect(() => {
    setFlowNodes(current => query.sources.map((source, index) => {
      const sourceJoins = query.joins.flatMap(j => {
        const conds = j.conditions?.length ? j.conditions : j.left_field && j.right_field
          ? [{ left_field: j.left_field, right_field: j.right_field }] : []
        const fields: string[] = []
        if (j.left_alias === source.alias) fields.push(...conds.map(c => c.left_field))
        if (j.right_alias === source.alias) fields.push(...conds.map(c => c.right_field))
        return fields
      }).filter(Boolean)

      return {
        id: source.alias, type: 'table',
        position: current.find(node => node.id === source.alias)?.position || { x: 55 + index * 315, y: 60 },
        dragHandle: '.table-node-header',
        data: {
          alias: source.alias, tableName: source.table_name,
          fields: structureKeys[source.alias] === `${query.target}:${source.table_name}`
            ? structureFields[source.alias] || [] : [],
          loading: !!structureLoading[source.alias],
          joinedFields: Array.from(new Set(sourceJoins)),
        },
      }
    }))
  }, [structureSignature, query.target, query.joins, structureFields, structureKeys, structureLoading, setFlowNodes])

  useEffect(() => {
    const timer = window.setTimeout(() => flowRef.current?.fitView({ padding: 0.16, duration: 250 }), 120)
    return () => window.clearTimeout(timer)
  }, [structureSignature, structureKeys])

  function resetWorkspace() {
    setActiveReport('')
    setReportName('')
    setQuery({
      target: servers[0]?.id || '',
      sources: [blankSource(0)],
      joins: [],
      rowcount: 100,
    })
    setData({ columns: [], rows: [] })
    setVisibleColumns([])
    setVariants([])
    setVariantName('')
    setFlowNodes([])
    setStructureText({})
    setStructureFields({})
    setStructureKeys({})
    setStructureLoading({})
    setFieldSearch({})
    setFieldText({})
    setChanges([])
    setAiDraft(null)
    setAiPrompt('')
    setSchedules([])
    setRuns([])
    setScheduleReport('')
    setError('')
    setNotice('')
  }

  async function login(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const result = await post<{ user: User }>('/auth/login', { username: loginName, password: loginPassword })
      setUser(result.user); setLoginPassword('')
      resetWorkspace()
      await loadWorkspace()
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  async function logout() {
    await post('/auth/logout', {}).catch(() => {})
    setUser(null); setReports([])
    resetWorkspace()
  }

  function metadataFor(source: Source): StructureField[] {
    return structureKeys[source.alias] === `${query.target}:${source.table_name}`
      ? structureFields[source.alias] || [] : []
  }

  function updateSource(index: number, patch: Partial<Source>) {
    const existing = query.sources[index]
    if (patch.table_name !== undefined && patch.table_name !== existing.table_name) {
      setStructureText(current => { const next = { ...current }; delete next[existing.alias]; return next })
      setStructureFields(current => { const next = { ...current }; delete next[existing.alias]; return next })
      setStructureKeys(current => { const next = { ...current }; delete next[existing.alias]; return next })
      setFieldSearch(current => { const next = { ...current }; delete next[existing.alias]; return next })
    }
    setQuery(q => ({ ...q,
      sources: q.sources.map((s, i) => i === index ? {
        ...s, ...(patch.table_name !== undefined && patch.table_name !== s.table_name ? { fields: [], filters: [] } : {}), ...patch,
      } : s),
      joins: patch.table_name !== undefined && patch.table_name !== existing.table_name
        ? q.joins.map(join => join.left_alias === existing.alias || join.right_alias === existing.alias
          ? { ...join, left_field: '', right_field: '', conditions: [], manual: false } : join)
        : q.joins,
    }))
  }

  function updateFilter(sourceIndex: number, filterIndex: number, patch: Partial<Source['filters'][number]>) {
    const source = query.sources[sourceIndex]
    updateSource(sourceIndex, { filters: (source.filters || []).map((filter, i) =>
      i === filterIndex ? { ...filter, ...patch } : filter) })
  }

  function addSource() {
    if (query.sources.length >= 3) return
    const nextIndex = [0, 1, 2].find(index => !query.sources.some(source => source.alias === `T${index + 1}`))!
    const next = blankSource(nextIndex)
    setQuery(q => ({
      ...q,
      sources: [...q.sources, next],
      joins: [...q.joins, { left_alias: q.sources[0].alias, left_field: '',
        right_alias: next.alias, right_field: '', how: 'left' }],
    }))
  }

  function removeSource(index: number) {
    if (index === 0) return
    const alias = query.sources[index].alias
    setFieldText(current => { const next = { ...current }; delete next[alias]; return next })
    setQuery(q => {
      const sources = q.sources.filter((_, i) => i !== index)
      const joins = sources.slice(1).map((source, sourceIndex) => {
        const previous = q.joins.find(join => join.right_alias === source.alias)
        if (previous && sources.slice(0, sourceIndex + 1).some(item => item.alias === previous.left_alias)) return previous
        return { left_alias: sources[0].alias, left_field: '', right_alias: source.alias,
          right_field: '', how: 'left', conditions: [], manual: false }
      })
      return { ...q, sources, joins }
    })
  }

  function updateJoin(index: number, patch: Partial<Join>) {
    setQuery(q => ({ ...q, joins: q.joins.map((j, i) => i === index ? {
      ...j, ...patch, ...(patch.left_alias ? { left_field: '', right_field: '', conditions: [], manual: true } : {}),
    } : j) }))
  }

  function setJoinConditions(index: number, conditions: JoinCondition[]) {
    setQuery(q => ({ ...q, joins: q.joins.map((join, i) => i === index ? {
      ...join, conditions, manual: true,
      left_field: conditions[0]?.left_field || '', right_field: conditions[0]?.right_field || '',
    } : join) }))
  }

  function connectFields(connection: Connection) {
    const sourceIndex = query.sources.findIndex(source => source.alias === connection.source)
    const targetIndex = query.sources.findIndex(source => source.alias === connection.target)
    if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex ||
        !connection.sourceHandle || !connection.targetHandle) return
    const rightIndex = Math.max(sourceIndex, targetIndex)
    const leftAlias = query.sources[Math.min(sourceIndex, targetIndex)].alias
    const condition = sourceIndex < targetIndex
      ? { left_field: connection.sourceHandle, right_field: connection.targetHandle }
      : { left_field: connection.targetHandle, right_field: connection.sourceHandle }
    setQuery(current => ({ ...current, joins: current.joins.map((join, index) => {
      if (index !== rightIndex - 1) return join
      const existing = join.left_alias === leftAlias ? join.conditions ||
        (join.left_field && join.right_field ? [{ left_field: join.left_field, right_field: join.right_field }] : []) : []
      const conditions = existing.some(item => item.left_field === condition.left_field && item.right_field === condition.right_field)
        ? existing : [...existing, condition].slice(0, 10)
      return { ...join, left_alias: leftAlias, conditions, manual: true,
        left_field: conditions[0]?.left_field || '', right_field: conditions[0]?.right_field || '' }
    }) }))
  }

  async function inspectTable(source: Source) {
    setBusy(true); setError('')
    try {
      const result = await post<{ text: string; fields: { name: string; is_key: boolean; data_type: string }[] }>('/sap/table-structure', {
        target: query.target, table_name: source.table_name,
      })
      setStructureText(current => ({ ...current, [source.alias]: result.fields?.length ? '' : result.text || 'Struktur kosong.' }))
      setStructureFields(current => ({ ...current, [source.alias]: result.fields || [] }))
      setStructureKeys(current => ({ ...current, [source.alias]: `${query.target}:${source.table_name}` }))
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  async function runQuery() {
    if (!query.sources.some(source => source.fields.length)) {
      setError('Pilih setidaknya satu kolom Tampil sebelum menjalankan query.')
      return
    }
    if (query.joins.some(join => !(join.conditions?.length || (join.left_field && join.right_field)))) {
      setError('Lengkapi relasi join antar tabel sebelum menjalankan query.')
      return
    }
    setBusy(true); setError(''); setNotice('')
    try {
      const validReportId = reports.some(r => r.id === activeReport) ? activeReport : null
      const result = await post<GridData>('/sap/query', { ...query, report_id: validReportId })
      setData(result); setVisibleColumns(result.columns)
      setNotice(`${result.rows.length.toLocaleString('id-ID')} baris berhasil dimuat` +
        (result.warnings?.length ? ` · ${result.warnings.join(' ')}` : ''))
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  async function runPivot() {
    setBusy(true); setError('')
    try {
      const result = await post<GridData>('/data/pivot', {
        rows: data.rows, index: pivotIndex, columns: pivotColumn, values: pivotValue, aggregation: pivotAgg,
      })
      setData(result); setVisibleColumns(result.columns); setPivotOpen(false)
      setNotice('Data berhasil di-pivot.')
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  async function runFormula() {
    setBusy(true); setError('')
    try {
      const result = await post<GridData>('/data/formula', {
        rows: data.rows, name: formulaName.toUpperCase(), expression: formulaExpression,
      })
      setData(result); setVisibleColumns(result.columns)
      setFormulaOpen(false); setFormulaName(''); setFormulaExpression('')
      setNotice('Kolom formula ditambahkan.')
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  async function runCompare() {
    if (query.sources.length !== 1) { setError('Perbandingan memakai satu tabel. Hapus tabel join dahulu.'); return }
    setBusy(true); setError('')
    try {
      const source = query.sources[0]
      const result = await post<{ left_count: number; right_count: number; changes: typeof changes }>(
        '/sap/compare',
        { target: query.target, other_target: otherTarget, table_name: source.table_name,
          fields: source.fields, filters: source.filters, rowcount: query.rowcount,
          key_fields: compareKeys.split(',').map(x => x.trim()).filter(Boolean) },
      )
      setChanges(result.changes)
      setNotice(`${result.changes.length} perubahan dari ${result.left_count} dan ${result.right_count} baris.`)
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  async function saveReport() {
    const name = reportName.trim()
    if (!name) { setError('Isi nama laporan.'); return }
    setBusy(true); setError('')
    try {
      if (activeReport) {
        const saved = await api<{ id: string }>(`/reports/${encodeURIComponent(activeReport)}`, {
          method: 'PUT', body: JSON.stringify({ name, definition: query }),
        })
        setActiveReport(saved.id)
        setNotice(`Laporan "${name}" berhasil diperbarui.`)
      } else {
        const saved = await post<{ id: string }>('/reports', { name, definition: query })
        setActiveReport(saved.id)
        setNotice(`Laporan "${name}" berhasil disimpan.`)
      }
      await loadWorkspace()
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  async function saveAsNewReport() {
    const name = reportName.trim()
    if (!name) { setError('Isi nama laporan baru.'); return }
    setBusy(true); setError('')
    try {
      const saved = await post<{ id: string }>('/reports', { name, definition: query })
      setActiveReport(saved.id)
      await loadWorkspace()
      setNotice(`Laporan baru "${name}" berhasil dibuat (Save As).`)
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  function deleteReport(reportId: string, name: string) {
    showConfirm({
      title: 'Hapus Laporan',
      message: `Apakah Anda yakin ingin menghapus laporan "${name}"? Tindakan ini tidak dapat dibatalkan.`,
      confirmLabel: 'Hapus Laporan',
      confirmTone: 'danger',
      onConfirm: async () => {
        setBusy(true); setError('')
        try {
          await api(`/reports/${encodeURIComponent(reportId)}`, { method: 'DELETE' })
          if (activeReport === reportId) {
            resetWorkspace()
          }
          await loadWorkspace()
          setNotice(`Laporan "${name}" berhasil dihapus.`)
        } catch (e) { setError(message(e)) }
        finally { setBusy(false) }
      },
    })
  }

  async function selectReport(report: Report) {
    setQuery(report.definition); setActiveReport(report.id); setTab('builder')
    setReportName(report.name)
    setFieldText({}); setStructureFields({}); setStructureKeys({}); setStructureText({})
    setData({ columns: [], rows: [] }); setVisibleColumns([])
    try { setVariants(await api<typeof variants>(`/reports/${report.id}/variants`)) }
    catch (e) { setError(message(e)) }
  }

  async function saveVariant() {
    if (!activeReport || !variantName.trim()) { setError('Pilih laporan dan isi nama variant.'); return }
    try {
      await post(`/reports/${activeReport}/variants`, {
        name: variantName.trim(), layout: {
          columns: visibleColumns,
          columnState: gridRef.current?.api.getColumnState() || [],
          filterModel: gridRef.current?.api.getFilterModel() || {},
        },
      })
      setVariants(await api<typeof variants>(`/reports/${activeReport}/variants`))
      setVariantName(''); setNotice('Variant tersimpan.')
    } catch (e) { setError(message(e)) }
  }

  function applyVariant(variantId: string) {
    const variant = variants.find(x => x.id === variantId)
    if (!variant) return
    setVisibleColumns(variant.layout.columns)
    window.setTimeout(() => {
      if (variant.layout.columnState?.length) {
        gridRef.current?.api.applyColumnState({ state: variant.layout.columnState, applyOrder: true })
      }
      if (variant.layout.filterModel) gridRef.current?.api.setFilterModel(variant.layout.filterModel)
    }, 50)
  }

  async function exportData() {
    try {
      const res = await fetch('/api/data/export', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: data.rows, mask_fields: [], drop_duplicates: false }),
      })
      if (!res.ok) throw new Error('Ekspor gagal.')
      const url = URL.createObjectURL(await res.blob())
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = 'lumina-report.xlsx'; anchor.click()
      URL.revokeObjectURL(url)
    } catch (e) { setError(message(e)) }
  }

  async function saveCredential(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      await api(`/sap/credentials/${encodeURIComponent(credTarget)}`, {
        method: 'PUT', body: JSON.stringify({ username: sapUsername, password: sapPassword }),
      })
      setSapPassword(''); setSapUsername('')
      setCredentials(await api<Credential[]>('/sap/credentials'))
      setNotice('Kredensial tersimpan di vault OIDC.')
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  async function generateDraft() {
    setBusy(true); setError(''); setAiDraft(null)
    try {
      const result = await post<{ query: Query; explanation: string; requires_review: boolean }>(
        '/ai/draft-query', { prompt: aiPrompt, current_query: query },
      )
      setAiDraft({ query: result.query, explanation: result.explanation })
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  async function openAi() {
    setTab('ai')
    try {
      const result = await api<{ available: boolean; model: string }>('/ai/status')
      setAiModel(result.available ? result.model : 'Model lokal tidak tersedia')
    } catch { setAiModel('Model lokal tidak tersedia') }
  }

  async function openSchedules() {
    setTab('schedules')
    try {
      const [scheduled, history] = await Promise.all([
        api<Schedule[]>('/schedules'),
        api<ReportRun[]>('/report-runs'),
      ])
      setSchedules(scheduled)
      setRuns(history)
      setScheduleReport(current => current || reports[0]?.id || '')
    } catch (e) { setError(message(e)) }
  }

  async function createSchedule() {
    setBusy(true); setError('')
    try {
      await post('/schedules', { report_id: scheduleReport, interval_minutes: scheduleInterval })
      setSchedules(await api<Schedule[]>('/schedules'))
      setNotice('Jadwal laporan dibuat.')
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  async function toggleSchedule(schedule: Schedule) {
    try {
      await api(`/schedules/${schedule.id}`, { method: 'PUT', body: JSON.stringify({ enabled: !schedule.enabled }) })
      setSchedules(await api<Schedule[]>('/schedules'))
    } catch (e) { setError(message(e)) }
  }

  function removeSchedule(id: string) {
    showConfirm({
      title: 'Hapus Jadwal',
      message: 'Apakah Anda yakin ingin menghapus jadwal laporan ini?',
      confirmLabel: 'Hapus Jadwal',
      confirmTone: 'danger',
      onConfirm: async () => {
        try {
          await api(`/schedules/${id}`, { method: 'DELETE' })
          setSchedules(await api<Schedule[]>('/schedules'))
          setNotice('Jadwal laporan berhasil dihapus.')
        } catch (e) { setError(message(e)) }
      },
    })
  }

  async function runScheduleNow(id: string) {
    setBusy(true); setError('')
    try {
      const result = await post<{ success: boolean; error: string | null }>(`/schedules/${id}/run-now`, {})
      setSchedules(await api<Schedule[]>('/schedules'))
      setRuns(await api<ReportRun[]>('/report-runs'))
      if (result.success) setNotice('Laporan siap diunduh dari riwayat.')
      else setError(result.error || 'Jadwal gagal dijalankan.')
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  function removeCredential(connectionId: string) {
    showConfirm({
      title: 'Hapus Kredensial',
      message: 'Hapus kredensial SAP untuk target ini dari vault OIDC? Anda perlu memasukkan kredensial baru untuk menghubungkan kembali.',
      confirmLabel: 'Hapus Kredensial',
      confirmTone: 'danger',
      onConfirm: async () => {
        setBusy(true); setError('')
        try {
          await api(`/sap/credentials/${encodeURIComponent(connectionId)}`, { method: 'DELETE' })
          setCredentials(await api<Credential[]>('/sap/credentials'))
          setNotice('Kredensial dihapus dari vault OIDC.')
        } catch (e) { setError(message(e)) }
        finally { setBusy(false) }
      },
    })
  }

  const columns = useMemo<ColDef<Row>[]>(() => data.columns
    .filter(c => visibleColumns.includes(c))
    .map(c => ({
      field: c,
      headerName: c,
      valueGetter: params => params.data?.[c],
      minWidth: 150,
      filter: true,
      sortable: true,
      resizable: true,
    })),
  [data.columns, visibleColumns])

  const flowEdges = useMemo(() => query.joins.flatMap((join, index) => {
    const conditions = join.conditions?.length ? join.conditions : join.left_field && join.right_field
      ? [{ left_field: join.left_field, right_field: join.right_field }] : []
    return conditions.map((condition, conditionIndex) => ({
      id: `join-${index}-${conditionIndex}`, source: join.left_alias, target: join.right_alias,
      sourceHandle: condition.left_field, targetHandle: condition.right_field,
      markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#3d74c8', strokeWidth: 2 },
    }))
  }), [query.joins])

  if (loading) return <div className="loading-screen"><div className="spinner" />Memuat Lumina…</div>
  if (!user) return <div className="login-shell">
    <div className="login-aside"><div className="brand-mark"><Layers3 size={30} /></div>
      <div><span className="eyebrow light">ENTERPRISE REPORTING PLATFORM</span>
        <h1>Data SAP.<br /><em>Lebih terang.</em></h1>
        <p>Susun, bandingkan, dan pahami laporan bisnis dalam satu ruang kerja yang aman.</p></div>
      <div className="login-aside-foot"><ShieldCheck size={17} /> Terhubung melalui OIDC dan MCP Gateway</div>
    </div>
    <div className="login-panel"><form onSubmit={login} className="login-card">
      <div className="brand"><div className="brand-mark small"><Layers3 size={22} /></div><span>LUMINA</span></div>
      <span className="eyebrow">SELAMAT DATANG</span><h2>Masuk ke workspace</h2>
      <p>Gunakan akun OIDC perusahaan Anda.</p>
      <label>Username<input autoFocus value={loginName} onChange={e => setLoginName(e.target.value)} required /></label>
      <label>Password<input type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} required /></label>
      {error && <div className="alert error">{error}</div>}
      <button className="button primary full" disabled={busy}>{busy ? 'Menghubungkan…' : 'Masuk'} <ArrowRight size={18} /></button>
    </form></div>
  </div>

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark small"><Layers3 size={22} /></div><span>LUMINA</span></div>
      <div className="sidebar-label">WORKSPACE</div>
      <nav>
        <button className={tab === 'builder' ? 'active' : ''} onClick={() => setTab('builder')}><Columns3 size={18} /> Query Builder</button>
        <button className={tab === 'compare' ? 'active' : ''} onClick={() => setTab('compare')}><GitCompareArrows size={18} /> Bandingkan Data</button>
        <button className={tab === 'credentials' ? 'active' : ''} onClick={() => setTab('credentials')}><KeyRound size={18} /> Kredensial SAP</button>
        <button className={tab === 'ai' ? 'active' : ''} onClick={openAi}><WandSparkles size={18} /> Asisten AI</button>
        <button className={tab === 'schedules' ? 'active' : ''} onClick={openSchedules}><BarChart3 size={18} /> Jadwal & Riwayat</button>
      </nav>
      <div className="sidebar-label saved-label">LAPORAN TERSIMPAN <span>{reports.length}</span></div>
      <div className="report-list">{reports.map(r => (
        <div key={r.id} className={`report-item ${activeReport === r.id ? 'selected' : ''}`}>
          <button className="report-item-btn" onClick={() => selectReport(r)} title={r.name}>
            <Table2 size={15} /><span>{r.name}</span>
          </button>
          <button
            className="icon-button delete-report-btn"
            title={`Hapus "${r.name}"`}
            onClick={e => { e.stopPropagation(); deleteReport(r.id, r.name) }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      ))}
      {!reports.length && <p>Belum ada laporan.</p>}</div>
      <div className="sidebar-bottom"><div className="user-avatar">{(user.username || user.email || 'U')[0].toUpperCase()}</div>
        <div className="user-info"><strong>{user.username || user.email}</strong><small>{user.roles?.[0] || 'User'}</small></div>
        <button className="icon-button" title="Keluar" onClick={logout}><LogOut size={17} /></button></div>
    </aside>

    <main className="main">
      <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> {tab === 'builder' ? 'Query Builder' : tab === 'compare' ? 'Bandingkan Data' : tab === 'credentials' ? 'Kredensial SAP' : tab === 'ai' ? 'Asisten AI' : 'Jadwal & Riwayat'}</div>
        <div className="top-right"><span className="connection-dot" /> OIDC connected <div className="avatar-mini">{(user.username || 'U')[0].toUpperCase()}</div></div></header>
      <div className="content">
        {error && <div className="alert error dismiss" onClick={() => setError('')}>{error}<span>×</span></div>}
        {notice && <div className="alert success dismiss" onClick={() => setNotice('')}>{notice}<span>×</span></div>}
        {tab === 'builder' && <>
          <div className="page-heading"><div><span className="eyebrow">REPORT DESIGNER</span><h1>Query Builder</h1>
            <p>Susun sumber data SAP, hubungkan tabel, lalu lihat hasilnya.</p></div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="button subtle" onClick={resetWorkspace} title="Bersihkan canvas & mulai query baru"><Plus size={16} /> Query Baru</button>
              <button className="button primary" onClick={runQuery} disabled={busy || !query.target}><Play size={16} fill="currentColor" />{busy ? 'Memproses…' : 'Jalankan Query'}</button>
            </div></div>
          <div className="toolbar"><div className="field-group"><label>SERVER SAP</label>
            <select value={query.target} onChange={e => setQuery({ ...query, target: e.target.value })}>
              {servers.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></div>
            <div className="field-group narrow"><label>BATAS BARIS / TABEL</label>
              <input type="number" min={1} max={1000} value={query.rowcount} onChange={e => setQuery({ ...query, rowcount: Number(e.target.value) })} /></div>
            <div className="toolbar-spacer" /><div className="field-group save-inline">
              <label>
                {activeReport ? (
                  <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>EDIT LAPORAN</span>
                    <button type="button" className="text-button" style={{ fontSize: '10px', padding: 0 }}
                      onClick={() => { setActiveReport(''); setReportName('') }} title="Lepas dari laporan ini untuk membuat draf baru">✕ Draf baru</button>
                  </span>
                ) : 'SIMPAN LAPORAN'}
              </label>
              <div className="inline-control">
                <input placeholder="Nama laporan" value={reportName} onChange={e => setReportName(e.target.value)} />
                <button className="button primary" onClick={saveReport} title={activeReport ? "Perbarui laporan ini (replace)" : "Simpan laporan"}>
                  <Save size={15} /> Simpan
                </button>
                {activeReport && (
                  <button className="button subtle" onClick={saveAsNewReport} title="Simpan sebagai laporan baru (save as)">
                    <CopyPlus size={15} /> Simpan Baru
                  </button>
                )}
              </div>
            </div></div>
          <div className="builder-grid"><section className="card source-card"><div className="section-head"><div><span className="icon-tile blue"><Database size={18} /></span><strong>Sumber Data</strong></div>
            <button className="text-button" onClick={addSource} disabled={query.sources.length >= 3}><Plus size={16} /> Tambah Tabel</button></div>
            {query.sources.map((source, index) => <div className="source-form" key={index}>
              <div className="source-title"><span className="source-badge">{index + 1}</span><strong>Tabel {source.alias}</strong>
                {index > 0 && <button className="icon-button" title="Hapus tabel" onClick={() => removeSource(index)}><Trash2 size={15} /></button>}</div>
              <label>Nama tabel<input placeholder="Contoh: MARA" value={source.table_name}
                onChange={e => updateSource(index, { table_name: e.target.value.toUpperCase() })} /></label>
              <small className="metadata-status">{structureLoading[source.alias] ? 'Memuat struktur tabel…' :
                metadataFor(source).length ? `${metadataFor(source).length} kolom tersedia di canvas` :
                  'Isi nama tabel; kolom akan dimuat otomatis.'}</small>
              <button className="text-button structure-button" onClick={() => inspectTable(source)}
                disabled={!source.table_name || !query.target || busy}><Search size={14} /> Muat ulang struktur</button>
              {structureText[source.alias] && !metadataFor(source).length &&
                <div className="metadata-status">Struktur belum dapat dibaca. Coba muat ulang atau periksa akses SAP.</div>}
              {index > 0 && <div className="join-form"><span className="join-label">RELASI / JOIN</span>
                <div className="join-row"><select value={query.joins[index - 1]?.left_alias || query.sources[0].alias}
                  onChange={e => updateJoin(index - 1, { left_alias: e.target.value })}>
                  {query.sources.slice(0, index).map(s => <option key={s.alias}>{s.alias}</option>)}</select>
                  <select value={query.joins[index - 1]?.how || 'left'}
                    onChange={e => updateJoin(index - 1, { how: e.target.value })}><option value="left">LEFT JOIN</option><option value="inner">INNER JOIN</option></select></div>
                {(query.joins[index - 1]?.conditions?.length ? query.joins[index - 1].conditions! :
                  query.joins[index - 1]?.left_field && query.joins[index - 1]?.right_field
                    ? [{ left_field: query.joins[index - 1].left_field, right_field: query.joins[index - 1].right_field }] : [])
                  .map((condition, conditionIndex, conditions) => <div className="join-condition" key={conditionIndex}>
                    <select value={condition.left_field} onChange={e => setJoinConditions(index - 1,
                      conditions.map((item, i) => i === conditionIndex ? { ...item, left_field: e.target.value } : item))}>
                      <option value="">Field kiri</option>{metadataFor(query.sources.find(item => item.alias === query.joins[index - 1].left_alias) || query.sources[0]).map(field =>
                        <option key={field.name} value={field.name}>{field.name}</option>)}</select>
                    <span>=</span><select value={condition.right_field} onChange={e => setJoinConditions(index - 1,
                      conditions.map((item, i) => i === conditionIndex ? { ...item, right_field: e.target.value } : item))}>
                      <option value="">Field kanan</option>{metadataFor(source).map(field =>
                        <option key={field.name} value={field.name}>{field.name}</option>)}</select>
                    <button className="icon-button" title="Hapus kondisi join" onClick={() => setJoinConditions(index - 1,
                      conditions.filter((_, i) => i !== conditionIndex))}><Trash2 size={13} /></button></div>)}
                <button className="text-button" onClick={() => {
                  const join = query.joins[index - 1]
                  const existing = join.conditions?.length ? join.conditions : join.left_field && join.right_field
                    ? [{ left_field: join.left_field, right_field: join.right_field }] : []
                  setJoinConditions(index - 1, [...existing, { left_field: '', right_field: '' }])
                }} disabled={(query.joins[index - 1]?.conditions?.length || 0) >= 10}><Plus size={13} /> Tambah kondisi</button>
              </div>}
            </div>)}</section>
            <section className="card canvas-card"><div className="section-head"><div><span className="icon-tile purple"><Settings2 size={18} /></span><strong>Visual Canvas</strong></div>
              <span className="tiny-pill">Geser latar · Tarik header tabel · Hubungkan field</span></div>
              <div className="flow-wrap"><ReactFlow<TableFlowNode> nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes}
                onNodesChange={onNodesChange} onConnect={connectFields} onInit={instance => { flowRef.current = instance }}
                fitView panOnDrag nodesDraggable nodesConnectable elementsSelectable deleteKeyCode={null}
                minZoom={0.2} maxZoom={1.8}>
                  <Background color="#dae3ef" gap={20} /><Controls showInteractive={false} /></ReactFlow></div>
              <div className="canvas-foot"><span className="connection-dot" /> Semua operasi SAP melalui MCP Gateway</div></section></div>
          <section className="card field-selection-card"><div className="section-head"><div><span className="icon-tile blue"><Columns3 size={18} /></span><strong>Kolom Laporan & Parameter Filter</strong></div>
            <span className="tiny-pill">Pilih setelah tabel dan join siap</span></div>
            <p className="field-selection-intro">Kolom <strong>Tampil</strong> masuk hasil laporan. Kolom <strong>Filter</strong> menjadi parameter saat menjalankan query.</p>
            <div className="field-selection-grid">{query.sources.filter(source => source.table_name).map(source => {
              const sourceIndex = query.sources.findIndex(item => item.alias === source.alias)
              const fields = metadataFor(source)
              const term = (fieldSearch[source.alias] || '').toUpperCase()
              return <div className="field-selection-table" key={source.alias}><div className="field-selection-title"><strong>{source.table_name}</strong>
                <span>{source.fields.length} tampil · {source.filters.length} filter</span></div>
                <input placeholder="Cari kolom…" value={fieldSearch[source.alias] || ''}
                  onChange={e => setFieldSearch(current => ({ ...current, [source.alias]: e.target.value }))} />
                <div className="field-selection-head"><span>Kolom</span><span>Tampil</span><span>Filter</span></div>
                <div className="field-selection-list">{fields.filter(field => field.name.includes(term)).map(field => {
                  const selectedFilter = source.filters.some(filter => filter.field === field.name)
                  return <div className="field-selection-row" key={field.name}><span title={field.data_type}>
                    {field.is_key ? '◆ ' : ''}{field.name}<small>{field.data_type}</small></span>
                    <input type="checkbox" aria-label={`Tampilkan ${source.table_name}.${field.name}`}
                      checked={source.fields.includes(field.name)} onChange={e => updateSource(sourceIndex, {
                        fields: e.target.checked ? [...source.fields, field.name] : source.fields.filter(name => name !== field.name),
                      })} />
                    <input type="checkbox" aria-label={`Filter ${source.table_name}.${field.name}`}
                      checked={selectedFilter} disabled={!selectedFilter && source.filters.length >= 10}
                      onChange={e => updateSource(sourceIndex, { filters: e.target.checked
                        ? [...source.filters, { field: field.name, operator: 'EQ', value: '' }]
                        : source.filters.filter(filter => filter.field !== field.name),
                      })} /></div>
                })}{!fields.length && <div className="empty-small">Struktur tabel belum tersedia.</div>}</div>
                {!fields.length && <input placeholder="Fallback: MATNR, MTART" value={fieldText[source.alias] ?? source.fields.join(', ')}
                  onChange={e => { setFieldText(current => ({ ...current, [source.alias]: e.target.value.toUpperCase() }))
                    updateSource(sourceIndex, { fields: e.target.value.toUpperCase().split(',').map(value => value.trim()).filter(Boolean) }) }} />}
              </div>
            })}</div>
            {query.sources.some(source => source.filters.length) && <div className="parameter-panel"><strong>Nilai parameter</strong><small>Parameter kosong tidak membatasi hasil.</small>
              {query.sources.flatMap((source, sourceIndex) => source.filters.map((filter, filterIndex) =>
                <div className="parameter-row" key={`${source.alias}-${filter.field}`}><span>{source.table_name}.{filter.field}</span>
                  <select value={filter.operator} onChange={e => updateFilter(sourceIndex, filterIndex, { operator: e.target.value })}>
                    {['EQ', 'NE', 'GT', 'GE', 'LT', 'LE'].map(op => <option key={op}>{op}</option>)}</select>
                  <input placeholder="Nilai filter (opsional)" value={filter.value}
                    onChange={e => updateFilter(sourceIndex, filterIndex, { value: e.target.value })} /></div>))}</div>}
          </section>
          <section className="card results-card"><div className="section-head"><div><span className="icon-tile green"><BarChart3 size={18} /></span><strong>Hasil Laporan</strong><span className="count-pill">{data.rows.length} baris</span></div>
            <div className="results-actions"><button className="button subtle" onClick={() => setFormulaOpen(!formulaOpen)} disabled={!data.rows.length}><Plus size={16} /> Formula</button>
              <button className="button subtle" onClick={() => setPivotOpen(!pivotOpen)} disabled={!data.rows.length}><WandSparkles size={16} /> Pivot Data</button>
              <button className="button subtle" onClick={exportData} disabled={!data.rows.length}><Download size={16} /> Excel</button></div></div>
            {formulaOpen && <div className="pivot-panel"><div className="pivot-title"><Plus size={16} /> Kolom formula</div>
              <input placeholder="Nama kolom, contoh: TOTAL" value={formulaName} onChange={e => setFormulaName(e.target.value)} />
              <input className="formula-input" placeholder="Contoh: [T1.NETWR] * 1.11" value={formulaExpression} onChange={e => setFormulaExpression(e.target.value)} />
              <button className="button primary" onClick={runFormula} disabled={!formulaName || !formulaExpression}>Terapkan</button></div>}
            {pivotOpen && <div className="pivot-panel"><div className="pivot-title"><WandSparkles size={16} /> Pivot data</div>
              <select value={pivotIndex} onChange={e => setPivotIndex(e.target.value)}><option value="">Key / index</option>{data.columns.map(c => <option key={c}>{c}</option>)}</select>
              <select value={pivotColumn} onChange={e => setPivotColumn(e.target.value)}><option value="">Nama kolom baru</option>{data.columns.map(c => <option key={c}>{c}</option>)}</select>
              <select value={pivotValue} onChange={e => setPivotValue(e.target.value)}><option value="">Nilai</option>{data.columns.map(c => <option key={c}>{c}</option>)}</select>
              <select value={pivotAgg} onChange={e => setPivotAgg(e.target.value)}><option value="first">Nilai pertama</option><option value="sum">Jumlah</option><option value="count">Hitung</option><option value="min">Minimum</option><option value="max">Maksimum</option></select>
              <button className="button primary" onClick={runPivot} disabled={!pivotIndex || !pivotColumn || !pivotValue}>Terapkan</button></div>}
            {data.columns.length > 0 && <div className="column-picker"><span>Kolom:</span>{data.columns.map(c => <label key={c}><input type="checkbox" checked={visibleColumns.includes(c)}
              onChange={e => setVisibleColumns(v => e.target.checked ? [...v, c] : v.filter(x => x !== c))} />{c}</label>)}</div>}
            {data.rows.length ? <div className="ag-theme-quartz grid-wrap"><AgGridReact<Row> ref={gridRef} rowData={data.rows} columnDefs={columns}
              suppressFieldDotNotation={true}
              defaultColDef={{ filter: true, sortable: true, resizable: true }} pagination paginationPageSize={20} /></div>
              : <div className="empty-state"><div className="empty-illustration"><Search size={27} /></div><strong>Belum ada hasil</strong><p>Pilih tabel, periksa join, tandai kolom tampil dan filter, lalu jalankan query.</p></div>}
            {activeReport && <div className="variant-bar"><span><Layers3 size={15} /> Variant layout</span>
              <select onChange={e => applyVariant(e.target.value)} defaultValue="">
                <option value="">Pilih variant</option>{variants.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
              <input placeholder="Nama variant baru" value={variantName} onChange={e => setVariantName(e.target.value)} />
              <button className="button subtle" onClick={saveVariant}><Save size={14} /> Simpan layout</button></div>}</section>
        </>}
        {tab === 'compare' && <><div className="page-heading"><div><span className="eyebrow">DATA QUALITY</span><h1>Bandingkan Data</h1>
          <p>Temukan perbedaan data tabel yang sama di dua server SAP.</p></div><button className="button primary" onClick={runCompare} disabled={busy}><GitCompareArrows size={16} /> Bandingkan</button></div>
          <div className="card compare-card"><div className="compare-target"><label>SERVER SUMBER<select value={query.target} onChange={e => setQuery({ ...query, target: e.target.value })}>{servers.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
            <GitCompareArrows size={22} /><label>SERVER PEMBANDING<select value={otherTarget} onChange={e => setOtherTarget(e.target.value)}>{servers.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label></div>
            <div className="compare-options"><label>Tabel<input placeholder="MARA" value={query.sources[0].table_name} onChange={e => updateSource(0, { table_name: e.target.value.toUpperCase() })} /></label>
              <label>Fields<input placeholder="MATNR, MTART" value={fieldText[query.sources[0].alias] ?? query.sources[0].fields.join(', ')}
                onChange={e => {
                  setFieldText(current => ({ ...current, [query.sources[0].alias]: e.target.value.toUpperCase() }))
                  updateSource(0, { fields: e.target.value.toUpperCase().split(',').map(x => x.trim()).filter(Boolean) })
                }} /></label>
              <label>Key unik<input placeholder="MATNR" value={compareKeys} onChange={e => setCompareKeys(e.target.value.toUpperCase())} /></label></div></div>
          <div className="card changes-card"><div className="section-head"><div><span className="icon-tile purple"><GitCompareArrows size={18} /></span><strong>Perubahan</strong><span className="count-pill">{changes.length}</span></div></div>
            {changes.length ? <div className="change-list">{changes.map((change, i) => <div className="change-item" key={i}>
              <span className={`status-tag ${change.status}`}>{change.status === 'changed' ? 'BERUBAH' : change.status === 'only_left' ? 'HANYA SUMBER' : 'HANYA PEMBANDING'}</span>
              <strong>{Object.values(change.key).join(' · ')}</strong><div className="change-values"><pre>{JSON.stringify(change.left, null, 2)}</pre><ArrowRight size={16} /><pre>{JSON.stringify(change.right, null, 2)}</pre></div></div>)}</div>
              : <div className="empty-state"><div className="empty-illustration"><GitCompareArrows size={27} /></div><strong>Belum ada perbandingan</strong><p>Pilih dua server, tabel, fields, dan key unik.</p></div>}</div></>}
        {tab === 'credentials' && <><div className="page-heading"><div><span className="eyebrow">SECURE ACCESS</span><h1>Kredensial SAP</h1>
          <p>Kelola akses SAP pribadi Anda melalui vault OIDC pusat.</p></div></div>
          <div className="credentials-layout"><section className="card"><div className="section-head"><div><span className="icon-tile blue"><ShieldCheck size={18} /></span><strong>Status Koneksi</strong></div></div>
            {servers.map(server => { const cred = credentials.find(c => c.connectionId === server.id)
              return <div className="credential-row" key={server.id}><div className="server-icon"><Database size={19} /></div>
                <div><strong>{server.label}</strong><small>{server.environment || server.resource_key}</small></div>
                <span className={`credential-status ${cred?.hasCredential ? 'ready' : ''}`}>{cred?.hasCredential ? 'Tersimpan' : 'Belum diatur'}</span>
                {cred?.hasCredential && <button className="icon-button" title="Hapus kredensial" onClick={() => removeCredential(server.id)}><Trash2 size={15} /></button>}</div> })}
            {!servers.length && <div className="empty-small">Tidak ada server SAP pada katalog.</div>}</section>
            <section className="card"><div className="section-head"><div><span className="icon-tile purple"><KeyRound size={18} /></span><strong>Tambah / Ubah Kredensial</strong></div></div>
              <form className="credential-form" onSubmit={saveCredential}><label>Target SAP<select value={credTarget} onChange={e => setCredTarget(e.target.value)}>{servers.map(s => <option value={s.id} key={s.id}>{s.label}</option>)}</select></label>
                <label>Username SAP<input autoComplete="off" value={sapUsername} onChange={e => setSapUsername(e.target.value)} required placeholder="SAP_USERNAME" /></label>
                <label>Password SAP<input type="password" autoComplete="new-password" value={sapPassword} onChange={e => setSapPassword(e.target.value)} required placeholder="••••••••••" /></label>
                <div className="secure-note"><ShieldCheck size={17} /> Password dikirim ke vault OIDC dan tidak disimpan di Lumina.</div>
                <button className="button primary" disabled={busy || !credTarget}><Save size={16} /> Simpan ke Vault</button></form></section></div></>}
        {tab === 'ai' && <><div className="page-heading"><div><span className="eyebrow">LOCAL AI ASSISTANT</span><h1>Asisten Query</h1>
          <p>Jelaskan laporan yang diinginkan. Draf selalu ditinjau sebelum dijalankan.</p></div>
          <span className="tiny-pill">{aiModel || 'Memeriksa model…'}</span></div>
          <section className="card ai-card"><div className="section-head"><div><span className="icon-tile purple"><WandSparkles size={18} /></span><strong>Buat Draf Query</strong></div></div>
            <div className="ai-body"><label>Permintaan Anda<textarea value={aiPrompt} onChange={e => setAiPrompt(e.target.value)}
              placeholder="Contoh: Buat laporan material dari MARA dengan field MATNR, MTART, dan MEINS di server DEV…" rows={5} /></label>
              <p>Model menerima deskripsi dan struktur query saat ini. Data hasil SAP dan token OIDC tidak dikirim ke model.</p>
              <button className="button primary" onClick={generateDraft} disabled={busy || aiPrompt.trim().length < 5}>
                <WandSparkles size={16} />{busy ? 'Membuat draf…' : 'Buat Draf'}</button></div></section>
          {aiDraft && <section className="card ai-draft"><div className="section-head"><div><span className="icon-tile green"><Table2 size={18} /></span><strong>Draf untuk Ditinjau</strong></div>
            <span className="tiny-pill">Belum dieksekusi</span></div>
            <div className="ai-body"><p>{aiDraft.explanation || 'Periksa tabel, fields, filter, dan join sebelum menjalankan.'}</p>
              <div className="draft-summary"><div><small>SERVER</small><strong>{servers.find(s => s.id === aiDraft.query.target)?.label || aiDraft.query.target}</strong></div>
                <div><small>TABEL</small><strong>{aiDraft.query.sources.map(s => s.table_name).join(' + ')}</strong></div>
                <div><small>BATAS BARIS</small><strong>{aiDraft.query.rowcount}</strong></div></div>
              <pre className="draft-json">{JSON.stringify(aiDraft.query, null, 2)}</pre>
              <button className="button primary" onClick={() => {
                setQuery(aiDraft.query); setFieldText({}); setTab('builder'); setAiDraft(null); setNotice('Draf dimuat. Tinjau lalu jalankan query.')
              }}><ArrowRight size={16} /> Terapkan ke Builder</button></div></section>}</>}
        {tab === 'schedules' && <><div className="page-heading"><div><span className="eyebrow">AUTOMATION</span><h1>Jadwal & Riwayat</h1>
          <p>Jalankan laporan tersimpan secara berkala dengan identitas OIDC Anda. Unduh hasil Excel dari riwayat.</p></div></div>
          <section className="card schedule-card"><div className="section-head"><div><span className="icon-tile blue"><Plus size={18} /></span><strong>Buat Jadwal</strong></div></div>
            <div className="schedule-form"><label>Laporan<select value={scheduleReport} onChange={e => setScheduleReport(e.target.value)}>
              <option value="">Pilih laporan</option>{reports.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
              <label>Frekuensi<select value={scheduleInterval} onChange={e => setScheduleInterval(Number(e.target.value))}>
                <option value={60}>Setiap jam</option><option value={360}>Setiap 6 jam</option><option value={1440}>Setiap hari</option><option value={10080}>Setiap minggu</option></select></label>
              <button className="button primary" onClick={createSchedule} disabled={busy || !scheduleReport}><Plus size={16} /> Buat</button></div></section>
          <section className="card schedule-card"><div className="section-head"><div><span className="icon-tile purple"><BarChart3 size={18} /></span><strong>Jadwal Aktif</strong><span className="count-pill">{schedules.length}</span></div></div>
            {schedules.length ? schedules.map(s => <div className="schedule-row" key={s.id}><div><strong>{reports.find(r => r.id === s.report_id)?.name || s.report_id}</strong>
              <small>Setiap {s.interval_minutes === 1440 ? 'hari' : s.interval_minutes === 10080 ? 'minggu' : s.interval_minutes + ' menit'} · Berikutnya {new Date(s.next_run_at).toLocaleString('id-ID')}</small>
              <small>Status: {s.last_status || 'Belum dijalankan'}{s.last_error ? ' · ' + s.last_error : ''}</small></div>
              <div className="schedule-actions"><button className="button subtle" onClick={() => runScheduleNow(s.id)} disabled={busy || !s.enabled}><Play size={14} /> Jalankan</button>
                <button className="button subtle" onClick={() => toggleSchedule(s)}>{s.enabled ? 'Jeda' : 'Aktifkan'}</button>
                <button className="icon-button" title="Hapus" onClick={() => removeSchedule(s.id)}><Trash2 size={15} /></button></div></div>)
              : <div className="empty-small">Belum ada jadwal.</div>}</section>
          <section className="card schedule-card"><div className="section-head"><div><span className="icon-tile green"><Table2 size={18} /></span><strong>Riwayat Eksekusi</strong></div></div>
            {runs.length ? runs.map(run => <div className="history-row" key={run.id}><span className={`status-tag ${run.status === 'success' ? 'only_right' : 'only_left'}`}>{run.status.toUpperCase()}</span>
              <strong>{run.report_id ? reports.find(r => r.id === run.report_id)?.name || 'Laporan terhapus' : 'Query ad hoc'}</strong>
              <span>{run.row_count} baris</span><small>{new Date(run.started_at).toLocaleString('id-ID')}</small>
              {run.has_artifact ? <a className="button subtle" href={`/api/report-runs/${run.id}/download`}><Download size={14} /> Unduh</a> : <span />}</div>)
              : <div className="empty-small">Belum ada riwayat.</div>}</section></>}
      </div>
    </main>
    {confirmModal.open && (
      <div className="modal-backdrop" onClick={() => setConfirmModal(c => ({ ...c, open: false }))}>
        <div className="modal-card" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <div className="modal-title">
              <span className="modal-title-icon"><AlertTriangle size={17} /></span>
              <span>{confirmModal.title}</span>
            </div>
            <button
              className="icon-button"
              title="Tutup"
              onClick={() => setConfirmModal(c => ({ ...c, open: false }))}
            >
              <X size={16} />
            </button>
          </div>
          <div className="modal-body">
            {confirmModal.message}
          </div>
          <div className="modal-actions">
            <button
              className="button subtle"
              onClick={() => setConfirmModal(c => ({ ...c, open: false }))}
            >
              Batal
            </button>
            <button
              className={`button ${confirmModal.confirmTone === 'danger' ? 'danger' : 'primary'}`}
              onClick={() => {
                const action = confirmModal.onConfirm
                setConfirmModal(c => ({ ...c, open: false }))
                action()
              }}
            >
              {confirmModal.confirmLabel || 'Lanjutkan'}
            </button>
          </div>
        </div>
      </div>
    )}
  </div>
}

function message(e: unknown): string { return e instanceof Error ? e.message : 'Terjadi kesalahan.' }

export default App
