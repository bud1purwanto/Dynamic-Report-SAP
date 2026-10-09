import { useEffect, useMemo, useRef, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import type { ColDef } from 'ag-grid-community'
import { ReactFlow, Background, Controls, Handle, MarkerType, Position, useNodesState, useUpdateNodeInternals } from '@xyflow/react'
import type { Connection, Node, NodeProps, ReactFlowInstance } from '@xyflow/react'
import {
  AlertTriangle, ArrowRight, ArrowUp, BarChart3, BookOpen, CheckCircle2, ChevronDown, Columns3, CopyPlus, Database, Download,
  Edit2, GitCompareArrows, KeyRound, Layers3, Lock, LogOut, Play, Plus, Save, Search,
  Settings2, ShieldCheck, Table2, Trash2, X,
} from 'lucide-react'
import { api, post } from './api'
import type { GridData, Join, JoinCondition, Query, Row, Server, Source } from './api'

type User = { id?: string; username?: string; email?: string; roles?: string[]; mustChangePassword?: boolean }
type Report = { id: string; name: string; definition: Query }
type Credential = { connectionId: string; target?: string; hasCredential: boolean; username?: string }
type Variant = { id: string; name: string; layout: {
  columns: string[]
  columnState?: ReturnType<NonNullable<AgGridReact<Row>['api']>['getColumnState']>
  filterModel?: ReturnType<NonNullable<AgGridReact<Row>['api']>['getFilterModel']>
} }
type CompareVariant = {
  id: string
  name: string
  config: {
    target: string
    other_target: string
    table_name: string
    rowcount: number
    filters: Source['filters']
  }
}
type Tab = 'builder' | 'compare' | 'credentials' | 'schedules'
type Toast = { id: string; type: 'success' | 'error' | 'info'; message: string; title?: string }
type Schedule = { id: string; report_id: string; interval_minutes: number;
  enabled: boolean; next_run_at: string; last_run_at: string | null; last_status: string | null; last_error: string | null }
type ReportRun = { id: string; report_id: string | null; status: string; row_count: number; has_artifact: boolean;
  error: string | null; started_at: string }
type StructureField = { name: string; is_key: boolean; data_type: string; description?: string; check_table?: string }
function fieldTitle(field: StructureField): string {
  return [field.name, field.description, field.data_type].filter(Boolean).join(' · ')
}
function FieldName({ field, showType = false }: { field: StructureField; showType?: boolean }) {
  return <span className="technical-field" title={fieldTitle(field)}><strong>{field.name}</strong>{field.description && <span className="technical-description">{field.description}</span>}{showType && field.data_type && <small>{field.data_type}</small>}</span>
}
type CompareRow = { key: Row; status: string; changed_fields: string[]; left: Row | null; right: Row | null }

function compareValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

function ComparisonMatrix({ row, fields, descriptions, leftLabel, rightLabel, defaultOpen }: {
  row: CompareRow; fields: string[]; descriptions: Record<string, string>; leftLabel: string; rightLabel: string; defaultOpen: boolean
}) {
  const [expanded, setExpanded] = useState(defaultOpen)
  const [filterMode, setFilterMode] = useState<'all' | 'different' | 'same'>('all')
  const [sortOrder, setSortOrder] = useState<'sap' | 'az' | 'diff_first'>('sap')
  const [matrixSearch, setMatrixSearch] = useState('')

  const isMissing = !row.left || !row.right
  const differentCount = isMissing ? fields.length : row.changed_fields.length
  const status = row.status === 'same' ? 'Sama' : row.status === 'changed' ? 'Berubah'
    : row.status === 'only_left' ? 'Hanya sumber' : 'Hanya pembanding'

  const filteredSortedFields = useMemo(() => {
    let result = [...fields]
    const term = matrixSearch.trim().toUpperCase()

    // 1. Text Search Filter
    if (term) {
      result = result.filter(field => {
        const desc = (descriptions[field] || '').toUpperCase()
        return field.includes(term) || desc.includes(term)
      })
    }

    // 2. Status Filter
    if (filterMode === 'different') {
      result = result.filter(field => isMissing || row.changed_fields.includes(field))
    } else if (filterMode === 'same') {
      result = result.filter(field => !isMissing && !row.changed_fields.includes(field))
    }

    // 3. Sorting
    if (sortOrder === 'az') {
      result.sort((a, b) => a.localeCompare(b))
    } else if (sortOrder === 'diff_first') {
      result.sort((a, b) => {
        const aDiff = isMissing || row.changed_fields.includes(a) ? 0 : 1
        const bDiff = isMissing || row.changed_fields.includes(b) ? 0 : 1
        if (aDiff !== bDiff) return aDiff - bDiff
        return fields.indexOf(a) - fields.indexOf(b)
      })
    } // 'sap' keeps original SAP Dictionary sequence from `fields`

    return result
  }, [fields, descriptions, matrixSearch, filterMode, sortOrder, isMissing, row.changed_fields])

  return <details className={`compare-record ${row.status}`} open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary className="compare-record-head"><div className="compare-record-title"><span className={`status-tag ${row.status}`}>{status.toUpperCase()}</span>
      <strong title={Object.keys(row.key).map(field => `${field}${descriptions[field] ? ` (${descriptions[field]})` : ''}`).join(' · ')}>{Object.entries(row.key).map(([field, value]) => `${field}: ${value}`).join(' · ')}</strong></div>
      <div className="compare-record-counts"><span className="same-count"><CheckCircle2 size={14} /> {isMissing ? 0 : fields.length - differentCount} sama</span>
        <span className="different-count"><AlertTriangle size={14} /> {differentCount} {isMissing ? 'tanpa pasangan' : 'berbeda'}</span><ChevronDown size={16} /></div></summary>
    <div className="compare-matrix-wrap">
      <div className="matrix-toolbar">
        <div className="matrix-search-box">
          <Search size={13} />
          <input
            placeholder="Cari kolom…"
            value={matrixSearch}
            onChange={e => setMatrixSearch(e.target.value)}
          />
        </div>
        <div className="matrix-toolbar-right">
          <div className="matrix-filter-group">
            <button
              type="button"
              className={`matrix-filter-btn ${filterMode === 'all' ? 'active' : ''}`}
              onClick={() => setFilterMode('all')}
            >
              Semua <span className="matrix-filter-count">{fields.length}</span>
            </button>
            <button
              type="button"
              className={`matrix-filter-btn diff ${filterMode === 'different' ? 'active' : ''}`}
              onClick={() => setFilterMode('different')}
            >
              Berbeda <span className="matrix-filter-count">{differentCount}</span>
            </button>
            <button
              type="button"
              className={`matrix-filter-btn same ${filterMode === 'same' ? 'active' : ''}`}
              onClick={() => setFilterMode('same')}
            >
              Sama <span className="matrix-filter-count">{isMissing ? 0 : fields.length - differentCount}</span>
            </button>
          </div>
          <div className="matrix-sort-group">
            <span>Urut:</span>
            <select
              value={sortOrder}
              onChange={e => setSortOrder(e.target.value as 'sap' | 'az' | 'diff_first')}
            >
              <option value="sap">Urutan SAP</option>
              <option value="diff_first">Berbeda Duluan</option>
              <option value="az">A - Z</option>
            </select>
          </div>
        </div>
      </div>
      <table className="compare-matrix"><thead><tr><th>Kolom tabel</th><th>{leftLabel}</th><th>{rightLabel}</th><th>Status</th></tr></thead>
      <tbody>{filteredSortedFields.map(field => {
        const fieldDiffers = isMissing || row.changed_fields.includes(field)
        return <tr className={fieldDiffers ? 'different' : 'same'} key={field}><th scope="row"><FieldName field={{ name: field, description: descriptions[field], data_type: '', is_key: false }} /></th>
          <td className={!row.left ? 'missing' : ''}>{row.left ? compareValue(row.left[field]) : 'Tidak ada baris'}</td>
          <td className={!row.right ? 'missing' : ''}>{row.right ? compareValue(row.right[field]) : 'Tidak ada baris'}</td>
          <td><span className={`matrix-status ${fieldDiffers ? 'different' : 'same'}`}>{fieldDiffers ? <AlertTriangle size={13} /> : <CheckCircle2 size={13} />}{isMissing ? 'Tanpa pasangan' : fieldDiffers ? 'Berbeda' : 'Sama'}</span></td></tr>
      })}
      {!filteredSortedFields.length && (
        <tr>
          <td colSpan={4} style={{ textAlign: 'center', padding: '24px', color: '#8898aa', fontSize: '12px' }}>
            Tidak ada kolom yang cocok dengan pencarian atau filter status ini.
          </td>
        </tr>
      )}</tbody></table></div></details>
}
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
  const linkedFields = useMemo(() => data.fields.filter(field => joinedSet.has(field.name)), [data.fields, joinedSet])

  const visibleFields = useMemo(() => {
    const term = search.trim().toUpperCase()
    return data.fields.filter(field => !joinedSet.has(field.name) && (!term || field.name.toUpperCase().includes(term) || field.data_type.toUpperCase().includes(term)))
  }, [data.fields, joinedSet, search])

  useEffect(() => {
    updateNodeInternals(id)
  }, [id, data.joinedFields, data.fields, search, updateNodeInternals])

  return <div className="table-node">
    <div className="table-node-header"><Table2 size={16} /><div><strong>{data.tableName || 'Pilih tabel'}</strong><small>{data.alias} · {data.fields.length} kolom</small></div></div>
    {data.fields.length > 6 && <div className="table-node-search-wrap nodrag"><Search size={12} />
      <input className="table-node-search" placeholder="Cari field…" value={search} onChange={e => setSearch(e.target.value)} /></div>}
    {linkedFields.length > 0 && <div className="table-node-relations nodrag"><div className="table-node-relations-label">RELASI AKTIF <span>{linkedFields.length}</span></div>
      {linkedFields.map(field => <div className="table-node-relation" key={field.name}>
        <Handle type="target" position={Position.Left} id={field.name} />
        <GitCompareArrows size={12} /><FieldName field={field} />
        <Handle type="source" position={Position.Right} id={field.name} />
      </div>)}</div>}
    <div className="table-node-fields nowheel nodrag" onScroll={() => updateNodeInternals(id)}>
      {visibleFields.length ? visibleFields.map(field => <div className="table-node-field" key={field.name}>
        <Handle type="target" position={Position.Left} id={field.name} />
        <span title={fieldTitle(field)}><FieldName field={field} />{field.is_key && <KeyRound size={11} className="key-icon" />}</span>
        <Handle type="source" position={Position.Right} id={field.name} />
      </div>) : <div className="table-node-empty">{data.loading ? 'Memuat kolom…' : data.tableName ? (search ? 'Tidak ada field cocok' : linkedFields.length ? 'Semua kolom sudah menjadi relasi aktif' : 'Struktur belum tersedia') : 'Isi nama tabel'}</div>}
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
  const [error, setErrorState] = useState('')
  const [notice, setNoticeState] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])

  const removeToast = (id: string) => {
    setToasts(current => current.filter(t => t.id !== id))
  }

  const pushToast = (toast: Omit<Toast, 'id'>) => {
    const id = Math.random().toString(36).substring(2, 9)
    setToasts(current => [...current, { ...toast, id }])
    window.setTimeout(() => {
      setToasts(current => current.filter(t => t.id !== id))
    }, toast.type === 'error' ? 5000 : 3500)
  }

  const setError = (msg: string) => {
    setErrorState(msg)
    if (msg) pushToast({ type: 'error', message: msg, title: 'Terjadi Kesalahan' })
  }

  const setNotice = (msg: string) => {
    setNoticeState(msg)
    if (msg) pushToast({ type: 'success', message: msg, title: 'Berhasil' })
  }
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
  const [resultPage, setResultPage] = useState(1)
  const [resultPageSize, setResultPageSize] = useState(25)
  const [resultSortCol, setResultSortCol] = useState<string | null>(null)
  const [resultSortDir, setResultSortDir] = useState<'asc' | 'desc'>('asc')
  const [pivotOpen, setPivotOpen] = useState(false)
  const [pivotIndex, setPivotIndex] = useState('')
  const [pivotColumn, setPivotColumn] = useState('')
  const [pivotValue, setPivotValue] = useState('')
  const [pivotAgg, setPivotAgg] = useState('first')
  const [formulaOpen, setFormulaOpen] = useState(false)
  const [formulaName, setFormulaName] = useState('')
  const [formulaExpression, setFormulaExpression] = useState('')
  const [otherTarget, setOtherTarget] = useState('')
  const [compareTarget, setCompareTarget] = useState('')
  const [compareTable, setCompareTable] = useState('')
  const [compareFilters, setCompareFilters] = useState<Source['filters']>([])
  const [compareMetadata, setCompareMetadata] = useState<StructureField[]>([])
  const [compareMetadataLoading, setCompareMetadataLoading] = useState(false)
  const [compareMetadataError, setCompareMetadataError] = useState('')
  const [compareFieldSearch, setCompareFieldSearch] = useState('')
  const [compareRowcount, setCompareRowcount] = useState(100)
  const [compareResult, setCompareResult] = useState<{ left_count: number; right_count: number; complete: boolean; row_limit: number; fields: string[]; key_fields: string[] } | null>(null)
  const [compareRows, setCompareRows] = useState<CompareRow[]>([])
  const [compareView, setCompareView] = useState<'all' | 'same' | 'different'>('all')
  const [compareVariants, setCompareVariants] = useState<CompareVariant[]>([])
  const [compareVariantName, setCompareVariantName] = useState('')
  const [activeCompareVariant, setActiveCompareVariant] = useState('')
  useEffect(() => { setCompareResult(null); setCompareRows([]) }, [compareTarget, otherTarget, compareTable, compareFilters, compareRowcount])
  useEffect(() => {
    setCompareMetadata([])
    setCompareMetadataError('')
    if (!compareTarget || !/^[A-Z_][A-Z0-9_]{1,29}$/.test(compareTable)) {
      setCompareMetadataLoading(false)
      return
    }
    let cancelled = false
    setCompareMetadataLoading(true)
    const timer = window.setTimeout(() => {
      post<{ fields: StructureField[] }>('/sap/table-structure', { target: compareTarget, table_name: compareTable })
        .then(result => { if (!cancelled) setCompareMetadata(result.fields || []) })
        .catch(e => { if (!cancelled) setCompareMetadataError(message(e)) })
        .finally(() => { if (!cancelled) setCompareMetadataLoading(false) })
    }, 400)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [compareTarget, compareTable])
  const [credTarget, setCredTarget] = useState('')
  const [sapUsername, setSapUsername] = useState('')
  const [sapPassword, setSapPassword] = useState('')
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [runs, setRuns] = useState<ReportRun[]>([])
  const [scheduleReport, setScheduleReport] = useState('')
  const [scheduleInterval, setScheduleInterval] = useState(1440)
  const [structureText, setStructureText] = useState<Record<string, string>>({})
  const [structureFields, setStructureFields] = useState<Record<string, StructureField[]>>({})
  const [structureKeys, setStructureKeys] = useState<Record<string, string>>({})
  const [structureLoading, setStructureLoading] = useState<Record<string, boolean>>({})
  const [fieldSearch, setFieldSearch] = useState<Record<string, string>>({})
  const [fieldFilterMode, setFieldFilterMode] = useState<Record<string, 'all' | 'selected' | 'keys'>>({})
  const [fieldSortOrder, setFieldSortOrder] = useState<Record<string, 'sap' | 'az' | 'selected_first' | 'keys_first'>>({})
  const [fieldText, setFieldText] = useState<Record<string, string>>({})
  const [confirmModal, setConfirmModal] = useState<{
    open: boolean
    title: string
    message: string
    confirmLabel?: string
    confirmTone?: 'danger' | 'primary'
    onConfirm: () => void
  }>({ open: false, title: '', message: '', onConfirm: () => {} })
  const [relationModal, setRelationModal] = useState<{ joinIndex: number; conditionIndex: number } | null>(null)
  const [catalogModal, setCatalogModal] = useState<{ open: boolean; targetIndex?: number; mode?: 'builder' | 'compare' }>({ open: false })
  const [catalogSearch, setCatalogSearch] = useState('')
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogTables, setCatalogTables] = useState<{ name: string; description: string }[]>([])

  // Modal Ganti Password OIDC
  const [changePasswordModal, setChangePasswordModal] = useState(false)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changePasswordLoading, setChangePasswordLoading] = useState(false)
  const [changePasswordError, setChangePasswordError] = useState('')
  const [userDropdownOpen, setUserDropdownOpen] = useState(false)

  const gridRef = useRef<AgGridReact<Row>>(null)
  const flowRef = useRef<ReactFlowInstance<TableFlowNode> | null>(null)
  const compareResultRef = useRef<HTMLDivElement>(null)
  const queryResultRef = useRef<HTMLDivElement>(null)
  const [flowNodes, setFlowNodes, onNodesChange] = useNodesState<TableFlowNode>([])

  function scrollToTop() {
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function openTableCatalog(targetIndex?: number, mode: 'builder' | 'compare' = 'builder') {
    setCatalogModal({ open: true, targetIndex, mode })
    setCatalogSearch('')
    setCatalogLoading(true)
    try {
      const res = await post<{ tables: { name: string; description: string }[] }>('/sap/search-tables', {
        target: mode === 'compare' ? compareTarget : query.target, query: '', limit: 30,
      })
      setCatalogTables(res.tables || [])
    } catch (e) {
      setError(message(e))
    } finally {
      setCatalogLoading(false)
    }
  }

  async function searchTableCatalog(q: string) {
    setCatalogSearch(q)
    setCatalogLoading(true)
    try {
      const res = await post<{ tables: { name: string; description: string }[] }>('/sap/search-tables', {
        target: catalogModal.mode === 'compare' ? compareTarget : query.target, query: q, limit: 30,
      })
      setCatalogTables(res.tables || [])
    } catch (e) {
      setError(message(e))
    } finally {
      setCatalogLoading(false)
    }
  }

  function pickTableFromCatalog(tableName: string) {
    if (catalogModal.mode === 'compare') {
      setCompareTable(tableName)
      setCompareFilters([])
      setCompareFieldSearch('')
    } else if (catalogModal.targetIndex !== undefined) {
      updateSource(catalogModal.targetIndex, { table_name: tableName })
    } else {
      // Add as new table source if under 3
      if (query.sources.length >= 3) {
        setError('Maksimal 3 tabel pada Query Builder.')
        setCatalogModal({ open: false })
        return
      }
      const nextIndex = [0, 1, 2].find(index => !query.sources.some(source => source.alias === `T${index + 1}`))!
      const next = { ...blankSource(nextIndex), table_name: tableName }
      setQuery(q => ({
        ...q,
        sources: [...q.sources, next],
        joins: [...q.joins, { left_alias: q.sources[0].alias, left_field: '',
          right_alias: next.alias, right_field: '', how: 'left' }],
      }))
    }
    setCatalogModal({ open: false })
  }

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
    const [catalog, saved, creds, compVariants] = await Promise.allSettled([
      api<{ resources: Server[] }>('/sap/servers'),
      api<Report[]>('/reports'),
      api<Credential[]>('/sap/credentials'),
      api<CompareVariant[]>('/compare-variants'),
    ])
    if (catalog.status === 'fulfilled') {
      const allowed = catalog.value.resources
      const hasTarget = (id: string) => allowed.some(server => server.id === id)
      setServers(allowed)
      setQuery(q => ({ ...q, target: hasTarget(q.target) ? q.target : allowed[0]?.id || '' }))
      setCompareTarget(t => hasTarget(t) ? t : allowed[0]?.id || '')
      setCredTarget(t => hasTarget(t) ? t : allowed[0]?.id || '')
      setOtherTarget(t => hasTarget(t) ? t : allowed.find(server => server.id !== (hasTarget(compareTarget) ? compareTarget : allowed[0]?.id))?.id || '')
    }
    if (saved.status === 'fulfilled') {
      setReports(saved.value)
      setActiveReport(cur => saved.value.some(r => r.id === cur) ? cur : '')
    }
    if (creds.status === 'fulfilled') setCredentials(creds.value)
    if (compVariants.status === 'fulfilled') setCompareVariants(compVariants.value)
    const failed = [catalog, saved, creds, compVariants].find(x => x.status === 'rejected')
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
    setRelationModal(null)
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
    setCompareRows([])
    setCompareResult(null)
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

  async function doLogout() {
    await post('/auth/logout', {}).catch(() => {})
    setUser(null); setReports([])
    resetWorkspace()
  }

  function confirmLogout() {
    showConfirm({
      title: 'Konfirmasi Keluar',
      message: 'Apakah Anda yakin ingin keluar dari sesi Lumina ini?',
      confirmLabel: 'Ya, Keluar',
      confirmTone: 'danger',
      onConfirm: doLogout,
    })
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

  function relationConditions(join: Join): JoinCondition[] {
    return join.conditions?.length ? join.conditions : join.left_field && join.right_field
      ? [{ left_field: join.left_field, right_field: join.right_field }] : []
  }

  function changeRelationField(patch: Partial<JoinCondition>) {
    if (!relationModal) return
    const join = query.joins[relationModal.joinIndex]
    if (!join) return
    setJoinConditions(relationModal.joinIndex, relationConditions(join).map((condition, index) =>
      index === relationModal.conditionIndex ? { ...condition, ...patch } : condition))
  }

  function deleteRelationField() {
    if (!relationModal) return
    const join = query.joins[relationModal.joinIndex]
    if (!join) return
    const remaining = relationConditions(join).filter((_, index) => index !== relationModal.conditionIndex)
    setJoinConditions(relationModal.joinIndex, remaining)
    setRelationModal(null)
    setNotice(remaining.length ? 'Kondisi relasi dihapus.' : 'Relasi dihapus. Hubungkan field kembali sebelum menjalankan query.')
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
      window.setTimeout(() => {
        queryResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
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
    if (!compareTarget || !otherTarget || compareTarget === otherTarget) { setError('Pilih dua server SAP yang berbeda.'); return }
    if (!compareTable.trim()) { setError('Isi nama tabel yang akan dibandingkan.'); return }
    if (compareFilters.some(filter => !filter.field.trim())) { setError('Isi field untuk setiap filter.'); return }
    if (compareFilters.some(filter => !filter.value.trim())) { setError('Isi nilai untuk setiap parameter yang dipilih.'); return }
    if (!Number.isInteger(compareRowcount) || compareRowcount < 1 || compareRowcount > 1000) { setError('Batas baris harus 1–1000.'); return }
    setBusy(true); setError(''); setCompareResult(null); setCompareRows([])
    try {
      const result = await post<NonNullable<typeof compareResult> & { rows: typeof compareRows }>(
        '/sap/compare',
        { target: compareTarget, other_target: otherTarget, table_name: compareTable.trim(),
          filters: compareFilters, rowcount: compareRowcount },
      )
      setCompareRows(result.rows)
      setCompareResult(result)
      const sameCount = result.rows.filter(row => row.status === 'same').length
      const diffCount = result.rows.filter(row => row.status !== 'same').length
      setNotice(`Perbandingan selesai: ${result.rows.length} record (${sameCount} identik, ${diffCount} record berbeda).` +
        (result.complete ? '' : ' Hasil mungkin parsial (mencapai batas baris).'))
      window.setTimeout(() => {
        compareResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
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
    setRelationModal(null)
    const targetAllowed = servers.some(server => server.id === report.definition.target)
    setQuery({ ...report.definition, target: targetAllowed ? report.definition.target : '' })
    if (!targetAllowed) setNotice('Server pada laporan ini tidak tersedia untuk akun Anda. Pilih server yang diizinkan sebelum menjalankan.')
    setActiveReport(report.id); setTab('builder')
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

  async function saveCompareVariant() {
    const name = compareVariantName.trim()
    if (!name) { setError('Isi nama variant perbandingan.'); return }
    if (!compareTarget || !otherTarget || !compareTable) {
      setError('Pilih server sumber, server pembanding, dan tabel terlebih dahulu.')
      return
    }
    setBusy(true); setError('')
    try {
      const config = {
        target: compareTarget,
        other_target: otherTarget,
        table_name: compareTable,
        rowcount: compareRowcount,
        filters: compareFilters,
      }
      await post('/compare-variants', { name, config })
      setCompareVariants(await api<CompareVariant[]>('/compare-variants'))
      setCompareVariantName('')
      setNotice(`Variant perbandingan "${name}" berhasil disimpan.`)
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  function applyCompareVariant(variantId: string) {
    setActiveCompareVariant(variantId)
    const variant = compareVariants.find(v => v.id === variantId)
    if (!variant) return
    const cfg = variant.config
    setCompareTarget(cfg.target || '')
    setOtherTarget(cfg.other_target || '')
    setCompareTable(cfg.table_name || '')
    setCompareRowcount(cfg.rowcount || 100)
    setCompareFilters(cfg.filters || [])
    setNotice(`Variant "${variant.name}" dimuat.`)
  }

  function deleteCompareVariant(variantId: string, name: string) {
    showConfirm({
      title: 'Hapus Variant Perbandingan',
      message: `Hapus variant perbandingan "${name}"? Tindakan ini tidak dapat dibatalkan.`,
      confirmLabel: 'Hapus Variant',
      confirmTone: 'danger',
      onConfirm: async () => {
        setBusy(true); setError('')
        try {
          await api(`/compare-variants/${encodeURIComponent(variantId)}`, { method: 'DELETE' })
          if (activeCompareVariant === variantId) {
            setActiveCompareVariant('')
          }
          setCompareVariants(await api<CompareVariant[]>('/compare-variants'))
          setNotice(`Variant "${name}" berhasil dihapus.`)
        } catch (e) { setError(message(e)) }
        finally { setBusy(false) }
      },
    })
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

  function editCredentialForServer(server: Server) {
    const cred = credentials.find(c => c.connectionId === server.id)
    setCredTarget(server.id)
    setSapUsername(cred?.username || '')
    setSapPassword('')
    setError('')
  }

  async function submitChangePassword(event?: React.FormEvent) {
    if (event) event.preventDefault()
    setChangePasswordError('')
    if (newPassword.length < 6) {
      setChangePasswordError('Password baru minimal 6 karakter.')
      return
    }
    if (newPassword !== confirmPassword) {
      setChangePasswordError('Konfirmasi password tidak cocok dengan password baru.')
      return
    }
    const isForced = !!user?.mustChangePassword
    if (!isForced && !oldPassword) {
      setChangePasswordError('Password saat ini wajib diisi.')
      return
    }

    setChangePasswordLoading(true)
    try {
      const payload: { new_password: string; old_password?: string } = { new_password: newPassword }
      if (!isForced && oldPassword) {
        payload.old_password = oldPassword
      }
      const res = await post<{ success: boolean; user: User }>('/auth/change-password', payload)
      setUser(res.user)
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setChangePasswordModal(false)
      setNotice('Password akun OIDC berhasil diperbarui.')
    } catch (e) {
      setChangePasswordError(message(e))
    } finally {
      setChangePasswordLoading(false)
    }
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

  const resultDescriptions = useMemo(() => Object.fromEntries(query.sources.flatMap(source => (structureFields[source.alias] || []).map(field => [`${source.alias}.${field.name}`, field.description || '']))), [query.sources, structureFields])
  const columns = useMemo<ColDef<Row>[]>(() => data.columns
    .filter(c => visibleColumns.includes(c))
    .map(c => ({
      field: c,
      headerName: resultDescriptions[c] ? `${c} · ${resultDescriptions[c]}` : c,
      headerTooltip: [c, resultDescriptions[c]].filter(Boolean).join(' · '),
      valueGetter: params => params.data?.[c],
      minWidth: 150,
      filter: true,
      sortable: true,
      resizable: true,
    })),
  [data.columns, visibleColumns, resultDescriptions])

  const sortedResultRows = useMemo(() => {
    if (!resultSortCol) return data.rows
    return [...data.rows].sort((a, b) => {
      const valA = a[resultSortCol] ?? ''
      const valB = b[resultSortCol] ?? ''
      if (typeof valA === 'number' && typeof valB === 'number') {
        return resultSortDir === 'asc' ? valA - valB : valB - valA
      }
      const strA = String(valA)
      const strB = String(valB)
      return resultSortDir === 'asc' ? strA.localeCompare(strB) : strB.localeCompare(strA)
    })
  }, [data.rows, resultSortCol, resultSortDir])

  const paginatedResultRows = useMemo(() => {
    const start = (resultPage - 1) * resultPageSize
    return sortedResultRows.slice(start, start + resultPageSize)
  }, [sortedResultRows, resultPage, resultPageSize])

  const totalResultPages = Math.max(1, Math.ceil(data.rows.length / resultPageSize))

  const flowEdges = useMemo(() => query.joins.flatMap((join, index) => {
    const conditions = relationConditions(join)
    return conditions.map((condition, conditionIndex) => ({
      id: `join-${index}-${conditionIndex}`, source: join.left_alias, target: join.right_alias,
      sourceHandle: condition.left_field, targetHandle: condition.right_field,
      markerEnd: { type: MarkerType.ArrowClosed }, interactionWidth: 22,
      label: join.how === 'inner' ? 'INNER' : 'LEFT',
      labelStyle: { fill: '#315f9c', fontSize: 8, fontWeight: 700 },
      labelBgStyle: { fill: '#fff', stroke: '#cfdef2' }, labelBgBorderRadius: 4, labelBgPadding: [3, 2] as [number, number],
      style: { stroke: relationModal?.joinIndex === index && relationModal.conditionIndex === conditionIndex ? '#e2982f' : '#3d74c8', strokeWidth: 2.5 },
    }))
  }), [query.joins, relationModal])
  const editingJoin = relationModal ? query.joins[relationModal.joinIndex] : null
  const editingCondition = editingJoin && relationModal ? relationConditions(editingJoin)[relationModal.conditionIndex] : null
  const editingLeftSource = editingJoin ? query.sources.find(source => source.alias === editingJoin.left_alias) : null
  const editingRightSource = editingJoin ? query.sources.find(source => source.alias === editingJoin.right_alias) : null
  const editingLeftFields = editingLeftSource ? metadataFor(editingLeftSource) : []
  const editingRightFields = editingRightSource ? metadataFor(editingRightSource) : []

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
        <button className="icon-button" title="Keluar" onClick={confirmLogout}><LogOut size={17} /></button></div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div className="breadcrumb">Workspace <span>/</span> {tab === 'builder' ? 'Query Builder' : tab === 'compare' ? 'Bandingkan Data' : tab === 'credentials' ? 'Kredensial SAP' : 'Jadwal & Riwayat'}</div>
        <div className="top-right" style={{ position: 'relative' }}>
          <span className="connection-dot" />
          <span style={{ fontSize: '11px', color: '#4d627d' }}>OIDC connected</span>
          <button
            type="button"
            className="user-top-btn"
            onClick={() => setUserDropdownOpen(!userDropdownOpen)}
            title="Menu Akun OIDC"
          >
            <div className="avatar-mini">{(user.username || 'U')[0].toUpperCase()}</div>
            <span style={{ fontSize: '11px', fontWeight: 600, color: '#273c57' }}>{user.username || user.email}</span>
            <ChevronDown size={14} style={{ color: '#8898aa', transform: userDropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
          </button>
          {userDropdownOpen && (
            <div className="user-dropdown-menu" onClick={e => e.stopPropagation()}>
              <div className="user-dropdown-header">
                <strong>{user.username || user.email}</strong>
                <small>{user.roles?.[0] || 'User'} · OIDC Account</small>
              </div>
              <button
                type="button"
                className="user-dropdown-item"
                onClick={() => {
                  setUserDropdownOpen(false)
                  setChangePasswordError('')
                  setOldPassword('')
                  setNewPassword('')
                  setConfirmPassword('')
                  setChangePasswordModal(true)
                }}
              >
                <Lock size={14} /> Ganti Password OIDC
              </button>
              <button
                type="button"
                className="user-dropdown-item text-danger"
                onClick={() => {
                  setUserDropdownOpen(false)
                  confirmLogout()
                }}
              >
                <LogOut size={14} /> Keluar
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="content">
        {tab === 'builder' && <>
          <div className="page-heading"><div><span className="eyebrow">REPORT DESIGNER</span><h1>Query Builder</h1>
            <p>Susun sumber data SAP, hubungkan tabel, lalu lihat hasilnya.</p></div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="button subtle" onClick={resetWorkspace} title="Bersihkan canvas & mulai query baru"><Plus size={16} /> Query Baru</button>
              <button className="button primary" onClick={runQuery} disabled={busy || !query.target}><Play size={16} fill="currentColor" />{busy ? 'Memproses…' : 'Jalankan Query'}</button>
            </div></div>
          <div className="toolbar"><div className="field-group"><label>SERVER SAP</label>
            <select value={query.target} onChange={e => setQuery({ ...query, target: e.target.value })}>
              <option value="">Pilih server yang diizinkan</option>
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
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <button className="text-button" onClick={() => openTableCatalog()} title="Buka katalog tabel SAP"><BookOpen size={15} /> Katalog Tabel</button>
              <button className="text-button" onClick={addSource} disabled={query.sources.length >= 3}><Plus size={16} /> Tambah Tabel</button>
            </div></div>
            {query.sources.map((source, index) => <div className="source-form" key={index}>
              <div className="source-title"><span className="source-badge">{index + 1}</span><strong>Tabel {source.alias}</strong>
                {index > 0 && <button className="icon-button" title="Hapus tabel" onClick={() => removeSource(index)}><Trash2 size={15} /></button>}</div>
              <label>Nama tabel
                <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  <input placeholder="Contoh: MARA" value={source.table_name}
                    onChange={e => updateSource(index, { table_name: e.target.value.toUpperCase() })} />
                  <button className="button subtle" style={{ padding: '0.45rem 0.6rem', height: '36px', whiteSpace: 'nowrap' }}
                    onClick={() => openTableCatalog(index)} title="Cari di katalog tabel SAP">
                    <BookOpen size={14} /> Katalog
                  </button>
                </div>
              </label>
              <small className="metadata-status">{structureLoading[source.alias] ? 'Memuat struktur tabel…' :
                metadataFor(source).length ? `${metadataFor(source).length} kolom tersedia di canvas` :
                  'Isi nama tabel; kolom akan dimuat otomatis.'}</small>
              {metadataFor(source).length > 0 && !metadataFor(source).some(field => field.description) &&
                <small className="metadata-status">Teks deskripsi kolom tidak tersedia dari SAP untuk tabel ini.</small>}
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
                        <option key={field.name} value={field.name}>{field.name}{field.description ? ` · ${field.description}` : ''}</option>)}</select>
                    <span>=</span><select value={condition.right_field} onChange={e => setJoinConditions(index - 1,
                      conditions.map((item, i) => i === conditionIndex ? { ...item, right_field: e.target.value } : item))}>
                      <option value="">Field kanan</option>{metadataFor(source).map(field =>
                        <option key={field.name} value={field.name}>{field.name}{field.description ? ` · ${field.description}` : ''}</option>)}</select>
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
                onNodesChange={onNodesChange} onConnect={connectFields} onEdgeClick={(_, edge) => {
                  const match = /^join-(\d+)-(\d+)$/.exec(edge.id)
                  if (match) setRelationModal({ joinIndex: Number(match[1]), conditionIndex: Number(match[2]) })
                }} onInit={instance => { flowRef.current = instance }}
                fitView panOnDrag nodesDraggable nodesConnectable elementsSelectable deleteKeyCode={null}
                minZoom={0.2} maxZoom={1.8}>
                  <Background color="#dae3ef" gap={20} /><Controls showInteractive={false} /></ReactFlow></div>
              <div className="canvas-foot"><span className="connection-dot" /> Semua operasi SAP melalui MCP Gateway</div></section></div>
          <section className="card field-selection-card"><div className="section-head"><div><span className="icon-tile blue"><Columns3 size={18} /></span><strong>Kolom Laporan & Parameter Filter</strong></div>
            <span className="tiny-pill">Pilih setelah tabel dan join siap</span></div>
            <p className="field-selection-intro">Kolom <strong>Tampil</strong> masuk hasil laporan. Kolom <strong>Filter</strong> menjadi parameter saat menjalankan query.</p>
            <div className="field-selection-grid">{query.sources.filter(source => source.table_name).map(source => {
              const sourceIndex = query.sources.findIndex(item => item.alias === source.alias)
              const rawFields = metadataFor(source)
              const term = (fieldSearch[source.alias] || '').toUpperCase()
              const currentFilter = fieldFilterMode[source.alias] || 'all'
              const currentSort = fieldSortOrder[source.alias] || 'sap'

              let fields = rawFields.filter(field => {
                const desc = (field.description || '').toUpperCase()
                return !term || field.name.includes(term) || desc.includes(term) || field.data_type.toUpperCase().includes(term)
              })

              if (currentFilter === 'selected') {
                fields = fields.filter(f => source.fields.includes(f.name) || source.filters.some(flt => flt.field === f.name))
              } else if (currentFilter === 'keys') {
                fields = fields.filter(f => f.is_key)
              }

              if (currentSort === 'az') {
                fields = [...fields].sort((a, b) => a.name.localeCompare(b.name))
              } else if (currentSort === 'selected_first') {
                fields = [...fields].sort((a, b) => {
                  const aSel = source.fields.includes(a.name) || source.filters.some(flt => flt.field === a.name) ? 0 : 1
                  const bSel = source.fields.includes(b.name) || source.filters.some(flt => flt.field === b.name) ? 0 : 1
                  if (aSel !== bSel) return aSel - bSel
                  return rawFields.indexOf(a) - rawFields.indexOf(b)
                })
              } else if (currentSort === 'keys_first') {
                fields = [...fields].sort((a, b) => {
                  const aKey = a.is_key ? 0 : 1
                  const bKey = b.is_key ? 0 : 1
                  if (aKey !== bKey) return aKey - bKey
                  return rawFields.indexOf(a) - rawFields.indexOf(b)
                })
              }

              return <div className="field-selection-table" key={source.alias}><div className="field-selection-title"><strong>{source.table_name}</strong>
                <span>{source.fields.length} tampil · {source.filters.length} filter</span></div>
                <input placeholder="Cari kolom…" value={fieldSearch[source.alias] || ''}
                  onChange={e => setFieldSearch(current => ({ ...current, [source.alias]: e.target.value }))} />
                <div className="field-selection-controls">
                  <div className="field-filter-pills">
                    <button
                      type="button"
                      className={`field-filter-pill ${currentFilter === 'all' ? 'active' : ''}`}
                      onClick={() => setFieldFilterMode(c => ({ ...c, [source.alias]: 'all' }))}
                    >
                      Semua
                    </button>
                    <button
                      type="button"
                      className={`field-filter-pill ${currentFilter === 'selected' ? 'active' : ''}`}
                      onClick={() => setFieldFilterMode(c => ({ ...c, [source.alias]: 'selected' }))}
                    >
                      Dipilih ({source.fields.length})
                    </button>
                    <button
                      type="button"
                      className={`field-filter-pill ${currentFilter === 'keys' ? 'active' : ''}`}
                      onClick={() => setFieldFilterMode(c => ({ ...c, [source.alias]: 'keys' }))}
                    >
                      Key
                    </button>
                  </div>
                  <select
                    className="field-sort-select"
                    value={currentSort}
                    onChange={e => setFieldSortOrder(c => ({ ...c, [source.alias]: e.target.value as any }))}
                    title="Urutan kolom"
                  >
                    <option value="sap">Urutan SAP</option>
                    <option value="selected_first">Dipilih Duluan</option>
                    <option value="keys_first">Key Duluan</option>
                    <option value="az">A - Z</option>
                  </select>
                </div>
                <div className="field-selection-head"><span>Kolom</span><span>Tampil</span><span>Filter</span></div>
                <div className="field-selection-list">{fields.map(field => {
                  const selectedFilter = source.filters.some(filter => filter.field === field.name)
                  return <div className="field-selection-row" key={field.name}><span title={fieldTitle(field)}>
                    <FieldName field={field} showType />{field.is_key && <KeyRound size={11} className="key-icon" />}</span>
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
                })}{!fields.length && <div className="empty-small">{rawFields.length ? 'Tidak ada kolom cocok.' : 'Struktur tabel belum tersedia.'}</div>}</div>
                {!fields.length && <input placeholder="Fallback: MATNR, MTART" value={fieldText[source.alias] ?? source.fields.join(', ')}
                  onChange={e => { setFieldText(current => ({ ...current, [source.alias]: e.target.value.toUpperCase() }))
                    updateSource(sourceIndex, { fields: e.target.value.toUpperCase().split(',').map(value => value.trim()).filter(Boolean) }) }} />}
              </div>
            })}</div>
            {query.sources.some(source => source.filters.length) && <div className="parameter-panel"><strong>Nilai parameter</strong><small>Parameter kosong tidak membatasi hasil.</small>
              {query.sources.flatMap((source, sourceIndex) => source.filters.map((filter, filterIndex) =>
                <div className="parameter-row" key={`${source.alias}-${filter.field}`}><span title={metadataFor(source).find(field => field.name === filter.field)?.description || ''}>{source.table_name}.{filter.field}{metadataFor(source).find(field => field.name === filter.field)?.description && <small className="inline-description">{metadataFor(source).find(field => field.name === filter.field)?.description}</small>}</span>
                  <select value={filter.operator} onChange={e => updateFilter(sourceIndex, filterIndex, { operator: e.target.value })}>
                    {['EQ', 'NE', 'GT', 'GE', 'LT', 'LE'].map(op => <option key={op}>{op}</option>)}</select>
                  <input placeholder="Nilai filter (opsional)" value={filter.value}
                    onChange={e => updateFilter(sourceIndex, filterIndex, { value: e.target.value })} /></div>))}</div>}
          </section>
          <section className="card results-card" ref={queryResultRef}><div className="section-head"><div><span className="icon-tile green"><BarChart3 size={18} /></span><strong>Hasil Laporan</strong><span className="count-pill">{data.rows.length} baris</span></div>
            <div className="results-actions">
              <button className="button subtle" onClick={scrollToTop} title="Kembali ke atas"><ArrowUp size={15} /> Ke Atas</button>
              <button className="button subtle" onClick={() => setFormulaOpen(!formulaOpen)} disabled={!data.rows.length}><Plus size={16} /> Formula</button>
              <button className="button subtle" onClick={() => setPivotOpen(!pivotOpen)} disabled={!data.rows.length}><Settings2 size={16} /> Pivot Data</button>
              <button className="button subtle" onClick={exportData} disabled={!data.rows.length}><Download size={16} /> Excel</button>
            </div></div>
            {formulaOpen && <div className="pivot-panel"><div className="pivot-title"><Plus size={16} /> Kolom formula</div>
              <input placeholder="Nama kolom, contoh: TOTAL" value={formulaName} onChange={e => setFormulaName(e.target.value)} />
              <input className="formula-input" placeholder="Contoh: [T1.NETWR] * 1.11" value={formulaExpression} onChange={e => setFormulaExpression(e.target.value)} />
              <button className="button primary" onClick={runFormula} disabled={!formulaName || !formulaExpression}>Terapkan</button></div>}
            {pivotOpen && <div className="pivot-panel"><div className="pivot-title"><Settings2 size={16} /> Pivot data</div>
              <select value={pivotIndex} onChange={e => setPivotIndex(e.target.value)}><option value="">Key / index</option>{data.columns.map(c => <option key={c} value={c}>{c}{resultDescriptions[c] ? ` · ${resultDescriptions[c]}` : ''}</option>)}</select>
              <select value={pivotColumn} onChange={e => setPivotColumn(e.target.value)}><option value="">Nama kolom baru</option>{data.columns.map(c => <option key={c} value={c}>{c}{resultDescriptions[c] ? ` · ${resultDescriptions[c]}` : ''}</option>)}</select>
              <select value={pivotValue} onChange={e => setPivotValue(e.target.value)}><option value="">Nilai</option>{data.columns.map(c => <option key={c} value={c}>{c}{resultDescriptions[c] ? ` · ${resultDescriptions[c]}` : ''}</option>)}</select>
              <select value={pivotAgg} onChange={e => setPivotAgg(e.target.value)}><option value="first">Nilai pertama</option><option value="sum">Jumlah</option><option value="count">Hitung</option><option value="min">Minimum</option><option value="max">Maksimum</option></select>
              <button className="button primary" onClick={runPivot} disabled={!pivotIndex || !pivotColumn || !pivotValue}>Terapkan</button></div>}
            {data.columns.length > 0 && <div className="column-picker"><span>Kolom:</span>{data.columns.map(c => <label key={c}><input type="checkbox" checked={visibleColumns.includes(c)}
              onChange={e => setVisibleColumns(v => e.target.checked ? [...v, c] : v.filter(x => x !== c))} /><span title={[c, resultDescriptions[c]].filter(Boolean).join(' · ')}>{c}{resultDescriptions[c] && <small className="inline-description">{resultDescriptions[c]}</small>}</span></label>)}</div>}
            {data.rows.length ? (
              <div className="query-table-wrap">
                <table className="report-matrix">
                  <thead>
                    <tr>
                      <th className="row-idx">#</th>
                      {data.columns.filter(c => visibleColumns.includes(c)).map(c => {
                        const isSorted = resultSortCol === c
                        return (
                          <th
                            key={c}
                            onClick={() => {
                              if (resultSortCol === c) {
                                setResultSortDir(d => d === 'asc' ? 'desc' : 'asc')
                              } else {
                                setResultSortCol(c)
                                setResultSortDir('asc')
                              }
                            }}
                            title="Klik untuk mengurutkan data kolom ini"
                          >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                              <span>
                                <strong>{c}</strong>
                                {resultDescriptions[c] && <span className="technical-description" style={{ marginLeft: '6px', fontSize: '10px' }}>{resultDescriptions[c]}</span>}
                              </span>
                              {isSorted && (
                                <span style={{ fontSize: '10px', color: '#1d5cb4' }}>
                                  {resultSortDir === 'asc' ? '▲' : '▼'}
                                </span>
                              )}
                            </div>
                          </th>
                        )
                      })}
                    </tr>
                  </thead>
                  <tbody>
                    {paginatedResultRows.map((row, rowIdx) => {
                      const absoluteIdx = (resultPage - 1) * resultPageSize + rowIdx + 1
                      return (
                        <tr key={rowIdx}>
                          <th scope="row" className="row-idx">{absoluteIdx}</th>
                          {data.columns.filter(c => visibleColumns.includes(c)).map(c => {
                            const val = row[c]
                            const isEmpty = val === null || val === undefined || val === ''
                            return (
                              <td key={c} className={isEmpty ? 'cell-empty' : ''}>
                                {isEmpty ? '—' : String(val)}
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <div className="query-table-footer">
                  <div>
                    Menampilkan {data.rows.length === 0 ? 0 : (resultPage - 1) * resultPageSize + 1} – {Math.min(resultPage * resultPageSize, data.rows.length)} dari <strong>{data.rows.length}</strong> baris total
                  </div>
                  <div className="query-table-pagination">
                    <span style={{ marginRight: '8px' }}>Baris per halaman:</span>
                    <select
                      style={{ height: '28px', fontSize: '10px', padding: '0 6px', marginRight: '12px' }}
                      value={resultPageSize}
                      onChange={e => {
                        setResultPageSize(Number(e.target.value))
                        setResultPage(1)
                      }}
                    >
                      <option value={20}>20</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                      <option value={250}>250</option>
                    </select>

                    <button
                      type="button"
                      className="query-table-page-btn"
                      disabled={resultPage <= 1}
                      onClick={() => setResultPage(p => Math.max(1, p - 1))}
                      title="Halaman sebelumnya"
                    >
                      ‹
                    </button>
                    <span style={{ padding: '0 8px', fontWeight: 700, color: '#25446a' }}>
                      {resultPage} / {totalResultPages}
                    </span>
                    <button
                      type="button"
                      className="query-table-page-btn"
                      disabled={resultPage >= totalResultPages}
                      onClick={() => setResultPage(p => Math.min(totalResultPages, p + 1))}
                      title="Halaman berikutnya"
                    >
                      ›
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-illustration"><Search size={27} /></div>
                <strong>Belum ada hasil</strong>
                <p>Pilih tabel, periksa join, tandai kolom tampil dan filter, lalu jalankan query.</p>
              </div>
            )}
            {activeReport && <div className="variant-bar"><span><Layers3 size={15} /> Variant layout</span>
              <select onChange={e => applyVariant(e.target.value)} defaultValue="">
                <option value="">Pilih variant</option>{variants.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}</select>
              <input placeholder="Nama variant baru" value={variantName} onChange={e => setVariantName(e.target.value)} />
              <button className="button subtle" onClick={saveVariant}><Save size={14} /> Simpan layout</button></div>}</section>
        </>}
        {tab === 'compare' && <><div className="page-heading"><div><span className="eyebrow">DATA QUALITY</span><h1>Bandingkan Data</h1>
          <p>Temukan perbedaan data tabel yang sama di dua server SAP. Simpan parameter perbandingan sebagai variant untuk digunakan kembali.</p></div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="button primary" onClick={runCompare} disabled={busy || servers.length < 2}><GitCompareArrows size={16} /> Bandingkan</button>
          </div></div>
          {servers.length < 2 && <div className="alert error">Perbandingan memerlukan akses ke setidaknya dua server SAP. Periksa izin akun Anda.</div>}

          <div className="card compare-variant-toolbar" style={{ padding: '14px 20px', marginBottom: '18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: '280px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', fontWeight: 700, color: '#314e75' }}>
                <Layers3 size={16} style={{ color: '#4477c7' }} /> Variant Tersimpan:
              </span>
              <select
                style={{ height: '34px', fontSize: '11px', minWidth: '180px' }}
                value={activeCompareVariant}
                onChange={e => applyCompareVariant(e.target.value)}
              >
                <option value="">Pilih variant tersimpan ({compareVariants.length})</option>
                {compareVariants.map(v => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.config.table_name || 'Tabel'} · {v.config.target || ''})
                  </option>
                ))}
              </select>
              {activeCompareVariant && (
                <button
                  type="button"
                  className="icon-button"
                  title="Hapus variant ini"
                  onClick={() => {
                    const cur = compareVariants.find(v => v.id === activeCompareVariant)
                    if (cur) deleteCompareVariant(cur.id, cur.name)
                  }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                style={{ height: '34px', fontSize: '11px', width: '210px' }}
                placeholder="Nama variant (contoh: Cek MCH1 AIX-PRD)"
                value={compareVariantName}
                onChange={e => setCompareVariantName(e.target.value)}
              />
              <button
                type="button"
                className="button subtle"
                onClick={saveCompareVariant}
                disabled={busy || !compareTable}
                title="Simpan parameter server, tabel, filter, dan limit saat ini"
              >
                <Save size={14} /> Simpan Variant
              </button>
            </div>
          </div>
          <div className="card compare-card"><div className="compare-target"><label>SERVER SUMBER<select value={compareTarget} onChange={e => { setCompareTarget(e.target.value); setCompareFilters([]) }}><option value="">Pilih server</option>{servers.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
            <GitCompareArrows size={22} /><label>SERVER PEMBANDING<select value={otherTarget} onChange={e => setOtherTarget(e.target.value)}><option value="">Pilih server</option>{servers.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label></div>
            <div className="compare-options"><label>Tabel<div className="compare-table-picker"><input placeholder="MARA" value={compareTable} onChange={e => { setCompareTable(e.target.value.toUpperCase()); setCompareFilters([]) }} /><button className="button subtle" onClick={() => openTableCatalog(undefined, 'compare')} disabled={!compareTarget} title="Cari di katalog tabel SAP"><BookOpen size={14} /> Katalog</button></div></label>
              <p>Semua field tabel dibandingkan. Key baris diambil otomatis dari struktur SAP pada kedua server.</p></div>
            <div className="compare-field-panel"><div className="compare-field-heading"><div><strong>Kolom tabel</strong><small>Pilih kolom untuk dijadikan parameter filter. Semua kolom tetap dibandingkan.</small></div><input placeholder="Cari kolom…" value={compareFieldSearch} onChange={e => setCompareFieldSearch(e.target.value.toUpperCase())} disabled={!compareMetadata.length} /></div>
              {compareMetadata.length > 0 && !compareMetadata.some(field => field.description) && <span className="metadata-status">Teks deskripsi kolom tidak tersedia dari SAP untuk tabel ini.</span>}
              {compareMetadataLoading ? <span className="metadata-status">Memuat kolom tabel…</span> : compareMetadataError ? <span className="metadata-status">{compareMetadataError}</span> : compareMetadata.length ? <div className="compare-field-list">{compareMetadata.filter(field => field.name.includes(compareFieldSearch) || field.data_type.toUpperCase().includes(compareFieldSearch)).map(field => {
                const selected = compareFilters.some(filter => filter.field === field.name)
                return <label className="compare-field-choice" key={field.name}><input type="checkbox" checked={selected} disabled={!selected && compareFilters.length >= 10} onChange={e => setCompareFilters(current => e.target.checked ? [...current, { field: field.name, operator: 'EQ', value: '' }] : current.filter(filter => filter.field !== field.name))} />
                  <FieldName field={field} showType />{field.is_key && <KeyRound size={11} className="key-icon" />}</label>
              })}</div> : <span className="metadata-status">Isi nama tabel untuk melihat kolomnya.</span>}</div>
            <div className="compare-settings"><label>Batas baris per server<input type="number" min={1} max={1000} value={compareRowcount} onChange={e => setCompareRowcount(Number(e.target.value))} /></label>
              <div className="compare-filter-panel"><div className="filter-heading"><span>PARAMETER FILTER (BERLAKU UNTUK KEDUA SERVER)</span></div>
                {compareFilters.map((filter, index) => <div className="filter-row" key={filter.field}><strong title={compareMetadata.find(field => field.name === filter.field)?.description || ''}>{filter.field}{compareMetadata.find(field => field.name === filter.field)?.description && <small className="inline-description">{compareMetadata.find(field => field.name === filter.field)?.description}</small>}</strong>
                  <select value={filter.operator} onChange={e => setCompareFilters(current => current.map((item, i) => i === index ? { ...item, operator: e.target.value } : item))}>{['EQ', 'NE', 'GT', 'GE', 'LT', 'LE'].map(op => <option key={op}>{op}</option>)}</select>
                  <input placeholder="Nilai" value={filter.value} onChange={e => setCompareFilters(current => current.map((item, i) => i === index ? { ...item, value: e.target.value } : item))} />
                  <button className="icon-button" title="Hapus filter" onClick={() => setCompareFilters(current => current.filter((_, i) => i !== index))}><Trash2 size={14} /></button></div>)}
                {!compareFilters.length && <span className="metadata-status">Pilih kolom di atas untuk mengisi parameter.</span>}</div></div></div>
          <div className="card changes-card" ref={compareResultRef}>
            <div className="section-head">
              <div>
                <span className="icon-tile purple"><GitCompareArrows size={18} /></span>
                <strong>Hasil Perbandingan</strong>
                <span className="count-pill">{compareRows.length} record</span>
              </div>
              <div className="results-actions">
                <button className="button subtle" onClick={scrollToTop} title="Kembali ke atas">
                  <ArrowUp size={15} /> Ke Atas
                </button>
              </div>
            </div>
            {compareResult && <><div className={`compare-summary ${compareResult.complete ? '' : 'partial'}`}>{compareResult.left_count} baris sumber · {compareResult.right_count} baris pembanding · {compareResult.fields.length} field dibandingkan · key: {compareResult.key_fields.join(', ')} · {compareResult.complete ? 'Cakupan selesai.' : `Hasil mungkin parsial: salah satu server mencapai batas ${compareResult.row_limit} baris. Persempit data dengan filter.`}</div>
              <div className="compare-tabs">{([['all', 'Semua Record', compareRows.length], ['same', 'Record Identik', compareRows.filter(row => row.status === 'same').length], ['different', 'Record Berbeda', compareRows.filter(row => row.status !== 'same').length]] as const).map(([view, label, count]) => <button key={view} className={compareView === view ? 'active' : ''} onClick={() => setCompareView(view)}>{label} <span>{count}</span></button>)}</div></>}
            {compareResult ? (compareRows.filter(row => compareView === 'all' || (compareView === 'same' ? row.status === 'same' : row.status !== 'same')).length ? <div className="compare-record-list">{compareRows.filter(row => compareView === 'all' || (compareView === 'same' ? row.status === 'same' : row.status !== 'same')).map((row, i) =>
              <ComparisonMatrix key={Object.values(row.key).join('|')} row={row} fields={compareResult.fields} descriptions={Object.fromEntries(compareMetadata.map(field => [field.name, field.description || '']))}
                leftLabel={servers.find(server => server.id === compareTarget)?.label || 'Server sumber'}
                rightLabel={servers.find(server => server.id === otherTarget)?.label || 'Server pembanding'}
                defaultOpen={compareRows.length <= 2 || (i === 0 && compareView === 'different')} />)}</div>
              : <div className="empty-state"><strong>Tidak ada baris pada kategori ini</strong></div>)
              : <div className="empty-state"><div className="empty-illustration"><GitCompareArrows size={27} /></div><strong>Belum ada perbandingan</strong><p>Pilih dua server, tabel, dan parameter filter bila diperlukan.</p></div>}</div></>}
        {tab === 'credentials' && <><div className="page-heading"><div><span className="eyebrow">SECURE ACCESS</span><h1>Kredensial SAP</h1>
          <p>Kelola akses SAP pribadi Anda melalui vault OIDC pusat. Setiap target server dapat ditambahkan atau diperbarui kredensialnya.</p></div></div>
          <div className="credentials-layout"><section className="card"><div className="section-head"><div><span className="icon-tile blue"><ShieldCheck size={18} /></span><strong>Daftar Server SAP</strong></div>
            <span className="count-pill">{servers.length} server</span></div>
            {servers.map(server => {
              const cred = credentials.find(c => c.connectionId === server.id)
              const hasCred = !!cred?.hasCredential
              const isSelected = credTarget === server.id
              return <div className={`credential-row ${isSelected ? 'selected-server' : ''}`} key={server.id}>
                <div className="server-icon"><Database size={19} /></div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <strong>{server.label}</strong>
                    {hasCred && cred?.username && <span className="credential-user-badge">@{cred.username}</span>}
                  </div>
                  <small>{server.environment || server.resource_key}</small>
                </div>
                <span className={`credential-status ${hasCred ? 'ready' : ''}`}>
                  {hasCred ? 'Tersimpan' : 'Belum diatur'}
                </span>
                <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                  <button
                    className="button subtle"
                    style={{ padding: '0.35rem 0.65rem', height: '30px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '5px' }}
                    title={hasCred ? `Ubah kredensial ${server.label}` : `Atur kredensial ${server.label}`}
                    onClick={() => editCredentialForServer(server)}
                  >
                    {hasCred ? <Edit2 size={13} /> : <Plus size={13} />}
                    {hasCred ? 'Ubah' : 'Atur'}
                  </button>
                  {hasCred && (
                    <button
                      className="icon-button"
                      title="Hapus kredensial dari vault"
                      onClick={() => removeCredential(server.id)}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              </div>
            })}
            {!servers.length && <div className="empty-small">Tidak ada server SAP pada katalog OIDC.</div>}</section>
            <section className="card">
              <div className="section-head">
                <div>
                  <span className="icon-tile purple"><KeyRound size={18} /></span>
                  <strong>{credentials.find(c => c.connectionId === credTarget)?.hasCredential ? 'Ubah Kredensial' : 'Tambah Kredensial'}</strong>
                </div>
                {credentials.find(c => c.connectionId === credTarget)?.hasCredential && (
                  <span className="tiny-pill" style={{ color: '#2e976d', background: '#e8f8ef' }}>
                    <CheckCircle2 size={12} style={{ display: 'inline', marginRight: 4, verticalAlign: 'middle' }} />
                    Sudah ada data
                  </span>
                )}
              </div>
              <form className="credential-form" onSubmit={saveCredential}>
                <label>Target Server SAP
                  <select value={credTarget} onChange={e => {
                    const nextId = e.target.value
                    setCredTarget(nextId)
                    const existing = credentials.find(c => c.connectionId === nextId)
                    setSapUsername(existing?.username || '')
                    setSapPassword('')
                  }}>
                    {servers.map(s => {
                      const c = credentials.find(item => item.connectionId === s.id)
                      return (
                        <option value={s.id} key={s.id}>
                          {s.label} {c?.hasCredential ? '✓ (Sudah ada)' : '(Belum diatur)'}
                        </option>
                      )
                    })}
                  </select>
                </label>
                <label>
                  Username SAP
                  <input
                    autoComplete="off"
                    value={sapUsername}
                    onChange={e => setSapUsername(e.target.value)}
                    required
                    placeholder="Masukkan username SAP"
                  />
                </label>
                <label>
                  Password SAP
                  <input
                    type="password"
                    autoComplete="new-password"
                    value={sapPassword}
                    onChange={e => setSapPassword(e.target.value)}
                    required
                    placeholder={credentials.find(c => c.connectionId === credTarget)?.hasCredential ? 'Ketik password baru untuk memperbarui' : '••••••••••'}
                  />
                </label>
                <div className="secure-note">
                  <ShieldCheck size={17} />
                  <span>Kredensial disimpan terenkripsi di vault OIDC pusat (bukan di database Lumina) dan digunakan saat mengakses RFC SAP.</span>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button className="button primary" disabled={busy || !credTarget || !sapUsername.trim() || !sapPassword}>
                    <Save size={16} />
                    {credentials.find(c => c.connectionId === credTarget)?.hasCredential ? 'Perbarui di Vault' : 'Simpan ke Vault'}
                  </button>
                  {credentials.find(c => c.connectionId === credTarget)?.hasCredential && (
                    <button
                      type="button"
                      className="button subtle"
                      style={{ color: '#c93b4a' }}
                      onClick={() => removeCredential(credTarget)}
                    >
                      <Trash2 size={14} /> Hapus
                    </button>
                  )}
                </div>
              </form>
            </section>
          </div></>}
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
          <section className="card schedule-card">
            <div className="section-head">
              <div>
                <span className="icon-tile green"><Table2 size={18} /></span>
                <strong>Riwayat Eksekusi</strong>
              </div>
              <div className="results-actions">
                <button className="button subtle" onClick={scrollToTop} title="Kembali ke atas">
                  <ArrowUp size={15} /> Ke Atas
                </button>
              </div>
            </div>
            {runs.length ? runs.map(run => <div className="history-row" key={run.id}><span className={`status-tag ${run.status === 'success' ? 'only_right' : 'only_left'}`}>{run.status.toUpperCase()}</span>
              <strong>{run.report_id ? reports.find(r => r.id === run.report_id)?.name || 'Laporan terhapus' : 'Query ad hoc'}</strong>
              <span>{run.row_count} baris</span><small>{new Date(run.started_at).toLocaleString('id-ID')}</small>
              {run.has_artifact ? <a className="button subtle" href={`/api/report-runs/${run.id}/download`}><Download size={14} /> Unduh</a> : <span />}</div>)
              : <div className="empty-small">Belum ada riwayat.</div>}</section></>}
      </div>
    </main>
    {catalogModal.open && (
      <div className="modal-backdrop" onClick={() => setCatalogModal(c => ({ ...c, open: false }))}>
        <div className="modal-card catalog-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <div className="modal-title">
              <span className="modal-title-icon blue"><BookOpen size={18} /></span>
              <span>Katalog Tabel SAP</span>
            </div>
            <button
              className="icon-button"
              title="Tutup"
              onClick={() => setCatalogModal(c => ({ ...c, open: false }))}
            >
              <X size={16} />
            </button>
          </div>
          <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem', paddingBottom: '0.4rem' }}>
            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
              Cari tabel SAP standard atau kustom dari Data Dictionary (DD02T). Klik tabel untuk memilihnya.
            </p>
            <div className="catalog-search-wrap">
              <Search className="catalog-search-icon" size={16} />
              <input
                autoFocus
                placeholder="Cari tabel (contoh: MARA, VBAK, EKKO, MATERIAL)..."
                value={catalogSearch}
                onChange={e => searchTableCatalog(e.target.value)}
              />
              {catalogLoading && <span style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>Mencari…</span>}
            </div>

            <div className="catalog-list">
              {catalogTables.map(tbl => (
                <div key={tbl.name} className="catalog-item" onClick={() => pickTableFromCatalog(tbl.name)}>
                  <div className="catalog-item-info">
                    <span className="catalog-item-name">{tbl.name}</span>
                    <span className="catalog-item-desc">{tbl.description || 'Tidak ada deskripsi'}</span>
                  </div>
                  <button className="catalog-item-btn" type="button">
                    Pilih
                  </button>
                </div>
              ))}
              {!catalogLoading && catalogTables.length === 0 && (
                <div className="catalog-empty">
                  Tidak ditemukan tabel yang cocok dengan &quot;{catalogSearch}&quot;.
                </div>
              )}
            </div>
          </div>
          <div className="modal-actions">
            <button
              className="button subtle"
              onClick={() => setCatalogModal(c => ({ ...c, open: false }))}
            >
              Tutup
            </button>
          </div>
        </div>
      </div>
    )}
    {editingJoin && editingCondition && relationModal && (
      <div className="modal-backdrop" onClick={() => setRelationModal(null)}>
        <div className="modal-card relation-modal" onClick={event => event.stopPropagation()}>
          <div className="modal-head"><div className="modal-title"><span className="modal-title-icon blue"><GitCompareArrows size={18} /></span><span>Atur Relasi</span></div>
            <button className="icon-button" title="Tutup" onClick={() => setRelationModal(null)}><X size={16} /></button></div>
          <div className="relation-modal-body"><p>{editingLeftSource?.table_name || editingJoin.left_alias} → {editingRightSource?.table_name || editingJoin.right_alias}</p>
            <label>Jenis join<select value={editingJoin.how || 'left'} onChange={event => updateJoin(relationModal.joinIndex, { how: event.target.value })}>
              <option value="left">LEFT JOIN</option><option value="inner">INNER JOIN</option></select></label>
            <div className="relation-modal-fields"><label>Field sumber<select value={editingCondition.left_field} onChange={event => changeRelationField({ left_field: event.target.value })}>
              {!editingLeftFields.some(field => field.name === editingCondition.left_field) && <option value={editingCondition.left_field}>{editingCondition.left_field}</option>}
              {editingLeftFields.map(field => <option key={field.name} value={field.name}>{field.name}{field.description ? ` · ${field.description}` : ''}</option>)}</select></label>
              <span>=</span><label>Field tujuan<select value={editingCondition.right_field} onChange={event => changeRelationField({ right_field: event.target.value })}>
                {!editingRightFields.some(field => field.name === editingCondition.right_field) && <option value={editingCondition.right_field}>{editingCondition.right_field}</option>}
                {editingRightFields.map(field => <option key={field.name} value={field.name}>{field.name}{field.description ? ` · ${field.description}` : ''}</option>)}</select></label></div>
            <small>Perubahan langsung diterapkan pada canvas dan query.</small></div>
          <div className="modal-actions relation-modal-actions"><button className="button danger" onClick={deleteRelationField}><Trash2 size={14} /> {relationConditions(editingJoin).length === 1 ? 'Hapus relasi' : 'Hapus kondisi'}</button>
            <button className="button primary" onClick={() => setRelationModal(null)}>Selesai</button></div>
        </div>
      </div>
    )}
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
    {(changePasswordModal || !!user?.mustChangePassword) && (
      <div
        className="modal-backdrop"
        onClick={() => {
          if (!user?.mustChangePassword) {
            setChangePasswordModal(false)
          }
        }}
      >
        <div className="modal-card password-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <div className="modal-title">
              <span className="modal-title-icon purple"><Lock size={18} /></span>
              <span>{user?.mustChangePassword ? 'Wajib Ganti Password Akun' : 'Ganti Password OIDC'}</span>
            </div>
            {!user?.mustChangePassword && (
              <button
                className="icon-button"
                title="Tutup"
                onClick={() => setChangePasswordModal(false)}
              >
                <X size={16} />
              </button>
            )}
          </div>
          <form onSubmit={submitChangePassword}>
            <div className="modal-body" style={{ display: 'grid', gap: '14px' }}>
              {user?.mustChangePassword ? (
                <div className="alert info" style={{ margin: 0, fontSize: '11px' }}>
                  Akun Anda adalah pengguna baru atau baru saja di-reset. Demi keamanan, Anda <strong>wajib membuat password baru</strong> sebelum dapat melanjutkan. Tidak perlu memasukkan password lama/sementara.
                </div>
              ) : (
                <p style={{ margin: 0, fontSize: '12px', color: '#687b92' }}>
                  Perbarui kata sandi login OIDC Anda. Kata sandi ini berlaku untuk seluruh sistem Lumina.
                </p>
              )}

              {changePasswordError && (
                <div className="alert error" style={{ margin: 0, fontSize: '11px' }}>
                  {changePasswordError}
                </div>
              )}

              {!user?.mustChangePassword && (
                <label style={{ display: 'grid', gap: '6px', fontSize: '11px', fontWeight: 600, color: '#2b4466' }}>
                  Password Saat Ini
                  <input
                    type="password"
                    autoComplete="current-password"
                    placeholder="Masukkan password saat ini"
                    value={oldPassword}
                    onChange={e => setOldPassword(e.target.value)}
                    required
                  />
                </label>
              )}

              <label style={{ display: 'grid', gap: '6px', fontSize: '11px', fontWeight: 600, color: '#2b4466' }}>
                Password Baru (Minimal 6 karakter)
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Masukkan password baru"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  required
                  minLength={6}
                />
              </label>

              <label style={{ display: 'grid', gap: '6px', fontSize: '11px', fontWeight: 600, color: '#2b4466' }}>
                Konfirmasi Password Baru
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Ulangi password baru"
                  value={confirmPassword}
                  onChange={e => setConfirmPassword(e.target.value)}
                  required
                  minLength={6}
                />
              </label>
            </div>
            <div className="modal-actions">
              {!user?.mustChangePassword ? (
                <button
                  type="button"
                  className="button subtle"
                  onClick={() => setChangePasswordModal(false)}
                >
                  Batal
                </button>
              ) : (
                <button
                  type="button"
                  className="button subtle"
                  onClick={doLogout}
                  title="Keluar dari sesi ini"
                >
                  Keluar
                </button>
              )}
              <button
                type="submit"
                className="button primary"
                disabled={changePasswordLoading || !newPassword || !confirmPassword || (!user?.mustChangePassword && !oldPassword)}
              >
                {changePasswordLoading ? 'Menyimpan…' : 'Simpan Password Baru'}
              </button>
            </div>
          </form>
        </div>
      </div>
    )}
    {toasts.length > 0 && (
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`} role="alert">
            <div className="toast-icon-wrap">
              {t.type === 'success' && <CheckCircle2 size={16} />}
              {t.type === 'error' && <AlertTriangle size={16} />}
              {t.type === 'info' && <ShieldCheck size={16} />}
            </div>
            <div className="toast-content">
              {t.title && <div className="toast-title">{t.title}</div>}
              <div className="toast-desc">{t.message}</div>
            </div>
            <button
              type="button"
              className="toast-close"
              title="Tutup notifikasi"
              onClick={() => removeToast(t.id)}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    )}
  </div>
}

function message(e: unknown): string { return e instanceof Error ? e.message : 'Terjadi kesalahan.' }

export default App
