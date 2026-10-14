import { useEffect, useMemo, useRef, useState } from 'react'
import { AgGridReact } from 'ag-grid-react'
import type { ColDef } from 'ag-grid-community'
import { ReactFlow, Background, Controls, Handle, MarkerType, Position, useNodesState, useUpdateNodeInternals } from '@xyflow/react'
import type { Connection, Node, NodeProps, ReactFlowInstance } from '@xyflow/react'
import {
  AlertTriangle, ArrowRight, ArrowUp, BarChart3, BookOpen, Bot, CheckCircle2, ChevronDown, ChevronUp, Columns3, CopyPlus, Database, Download,
  Edit2, Eye, Filter, GitCompareArrows, GripVertical, KeyRound, Layers3, Lock, LogOut, Maximize2, Minimize2, MoreVertical, PanelLeftClose, PanelLeftOpen,
  Play, Plus, RotateCcw, RotateCw, Save, Scan, Search, Settings2, Share2, ShieldCheck, SlidersHorizontal, Sparkles, Table2, Trash2, UserCheck, UserPlus, Users, X,
} from 'lucide-react'
import { api, post } from './api'
import type { GridData, Join, JoinCondition, Query, Row, Server, Source } from './api'

type User = { id?: string; username?: string; email?: string; roles?: string[]; mustChangePassword?: boolean }
type PivotConfig = { rows: string[]; column: string; value: string; fallback_value?: string; aggregation: string }
type CalculatedColumn = { name: string; operation: string; fields?: string[]; expression?: string }
type ReportDefinition = Query & { presentation?: { pivot?: PivotConfig | null; calculatedColumns?: CalculatedColumn[]; visibleColumns?: string[] } }
type Report = { id: string; name: string; definition: ReportDefinition }
type SharedReport = {
  id: string
  name: string
  definition: ReportDefinition
  permission: 'view' | 'edit'
  shared_by: string
  share_id: string
  updated_at?: string
}

type BuilderHistoryItem = {
  query: Query
  calculatedColumns: CalculatedColumn[]
  activePivot: PivotConfig | null
  visibleColumns: string[]
}

type CompareHistoryItem = {
  compareTarget: string
  otherTarget: string
  compareTable: string
  compareRowcount: number
  compareFilters: Source['filters']
}

type AiProviderInfo = {
  name: string
  endpoint: string
  model: string
  configured: boolean
  online: boolean
}

type AiStatusResponse = {
  primary: AiProviderInfo
  fallback: AiProviderInfo
}

type AiGenerateResponse = {
  provider: string
  explanation: string
  data: {
    target?: string
    rowcount?: number
    sources?: {
      alias: string
      table_name: string
      fields: string[]
      filters?: { field: string; operator: string; value: string; high_value?: string; sign?: 'I' | 'E' }[]
    }[]
    joins?: {
      left_alias: string
      right_alias: string
      how?: string
      left_field?: string
      right_field?: string
      conditions?: { left_field: string; right_field: string }[]
    }[]
    calculatedColumns?: {
      name: string
      operation?: string
      expression?: string
      fields?: string[]
    }[]
    pivot?: {
      rows: string[]
      column: string
      value: string
      fallback_value?: string
      aggregation: string
    } | null
    visibleColumns?: string[]
    sort?: { column: string; direction?: 'asc' | 'desc' }
    other_target?: string
    table_name?: string
    filters?: { field: string; operator: string; value: string; high_value?: string; sign?: 'I' | 'E' }[]
  }
}
type ReportShareItem = {
  id: string
  report_id: string
  shared_with_username: string
  permission: 'view' | 'edit'
  created_at?: string
  updated_at?: string
}
type AvailableUser = {
  username: string
  name: string
  role: string
}
type Variant = { id: string; name: string; layout: {
  columns: string[]
  columnState?: ReturnType<NonNullable<AgGridReact<Row>['api']>['getColumnState']>
  filterModel?: ReturnType<NonNullable<AgGridReact<Row>['api']>['getFilterModel']>
} }
type SelectionTab = 'include_values' | 'include_ranges' | 'exclude_values' | 'exclude_ranges'
type SelectionDialog = {
  sourceIndex?: number
  context?: 'query' | 'compare'
  field: string
  tableName?: string
  tab: SelectionTab
  entries: Record<SelectionTab, string>
}
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
type Tab = 'builder' | 'compare' | 'schedules'
type Toast = { id: string; type: 'success' | 'error' | 'info'; message: string; title?: string }
type Schedule = { id: string; report_id: string; interval_minutes: number;
  enabled: boolean; next_run_at: string; last_run_at: string | null; last_status: string | null; last_error: string | null }
type ReportRun = { id: string; report_id: string | null; status: string; row_count: number; has_artifact: boolean;
  error: string | null; started_at: string }
type StructureField = {
  name: string
  is_key: boolean
  data_type: string
  description?: string
  check_table?: string
  length?: number
  output_length?: number
  decimals?: number
  position?: number
}

function fieldTitle(field: StructureField): string {
  const parts = [field.name, field.description]
  if (field.data_type) {
    const len = field.output_length || field.length
    parts.push(len ? `${field.data_type}(${len})` : field.data_type)
  }
  return parts.filter(Boolean).join(' · ')
}

function getFieldInputProps(meta?: StructureField, fieldName?: string) {
  const name = (meta?.name || fieldName || '').toUpperCase()
  let rawType = (meta?.data_type || '').toUpperCase()

  // Standard SAP numeric fields fallback if DDIC type was returned as generic CHAR or empty
  if (!rawType || rawType === 'CHAR') {
    if (['AUFNR', 'POSNR', 'BANFN', 'BNFPO', 'EBELP', 'VGPOS', 'LINUM', 'PERNR', 'VORNR', 'RSNUM', 'RSPOS'].includes(name) || name.endsWith('NUM')) {
      rawType = 'NUMC'
    } else if (name === 'MANDT') {
      rawType = 'CLNT'
    }
  }

  const isDate = rawType === 'DATS' || rawType === 'DATE' ||
    name.endsWith('DAT') || name.endsWith('DATE') || name.endsWith('DT') ||
    ['ERDAT', 'AEDAT', 'FKDAT', 'BLDAT', 'BUDAT', 'BEDAT', 'AUDAT', 'WADAT', 'LFDAT', 'CPUDT', 'DATUM'].includes(name)

  const isTime = rawType === 'TIMS' || rawType === 'TIME' || name.endsWith('TIM') || name.endsWith('TIME') || ['CPUTM', 'UZEIT', 'ERZET'].includes(name)

  const isPureNumber = ['NUMC', 'INT1', 'INT2', 'INT4', 'INT8', 'CLNT'].includes(rawType)
  const isNumeric = isPureNumber || ['DEC', 'CURR', 'QUAN', 'FLTP'].includes(rawType)

  let maxLength: number | undefined = meta?.output_length || meta?.length
  if (!maxLength) {
    if (isDate) maxLength = 10
    else if (isTime) maxLength = 8
    else if (name === 'MANDT') maxLength = 3
    else if (['WERKS', 'LGORT', 'BUKRS', 'GSBER', 'AUART', 'BSART', 'MTART', 'VKORG'].includes(name)) maxLength = 4
    else if (['VTWEG', 'SPART'].includes(name)) maxLength = 2
    else if (['BWART', 'MEINS'].includes(name)) maxLength = 3
    else if (['WAERK', 'WAERS'].includes(name)) maxLength = 5
    else if (name === 'POSNR') maxLength = 6
    else if (['CHARG', 'KUNNR', 'LIFNR', 'BELNR', 'EBELN', 'VBELN'].includes(name)) maxLength = 10
    else if (name === 'AUFNR') maxLength = 12
    else if (name === 'MATNR') maxLength = 18
  }

  const typeLabel = rawType
    ? `${rawType}${maxLength ? `(${maxLength})` : ''}`
    : isDate
      ? 'DATS(10)'
      : maxLength
        ? `CHAR(${maxLength})`
        : ''

  return {
    isDate,
    isTime,
    isNumeric,
    isPureNumber,
    maxLength,
    typeLabel,
  }
}

function toIsoDate(val: string): string {
  if (!val) return ''
  const t = val.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  const dmy = t.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/)
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
  }
  const ymd = t.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (ymd) {
    return `${ymd[1]}-${ymd[2]}-${ymd[3]}`
  }
  return ''
}

function toDisplayDate(iso: string): string {
  if (!iso) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split('-')
    return `${d}.${m}.${y}`
  }
  return iso
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
  const [reports, setReports] = useState<Report[]>([])
  const [sharedReports, setSharedReports] = useState<SharedReport[]>([])
  const [activeSharedPermission, setActiveSharedPermission] = useState<'owner' | 'view' | 'edit'>('owner')
  const [availableUsers, setAvailableUsers] = useState<AvailableUser[]>([])
  const [shareModal, setShareModal] = useState<{
    open: boolean
    report: Report | null
    shares: ReportShareItem[]
    loading: boolean
    targetUsername: string
    permission: 'view' | 'edit'
    saving: boolean
    error: string
  }>({
    open: false,
    report: null,
    shares: [],
    loading: false,
    targetUsername: '',
    permission: 'view',
    saving: false,
    error: '',
  })
  const [shareUserDropdownOpen, setShareUserDropdownOpen] = useState(false)
  const shareDropdownRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState<Query>(initialQuery)
  const [data, setData] = useState<GridData>({ columns: [], rows: [] })
  const [baseData, setBaseData] = useState<GridData>({ columns: [], rows: [] })
  const [calculatedColumns, setCalculatedColumns] = useState<CalculatedColumn[]>([])
  const [activePivot, setActivePivot] = useState<PivotConfig | null>(null)
  const [loginName, setLoginName] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [reportName, setReportName] = useState('')
  const [activeReport, setActiveReport] = useState('')
  const [variantName, setVariantName] = useState('')
  const [variants, setVariants] = useState<Variant[]>([])
  const [visibleColumns, setVisibleColumns] = useState<string[]>([])
  const [columnChooserOpen, setColumnChooserOpen] = useState(false)
  const [columnChooserSearch, setColumnChooserSearch] = useState('')
  const [parameterModalOpen, setParameterModalOpen] = useState(false)
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null)
  const [dropColumn, setDropColumn] = useState<string | null>(null)
  const [selectionDialog, setSelectionDialog] = useState<SelectionDialog | null>(null)
  const [resultPage, setResultPage] = useState(1)
  const [resultPageSize, setResultPageSize] = useState(25)
  const [resultSortCol, setResultSortCol] = useState<string | null>(null)
  const [resultSortDir, setResultSortDir] = useState<'asc' | 'desc'>('asc')
  const [sourcesCollapsed, setSourcesCollapsed] = useState(false)
  const [isCanvasFullscreen, setIsCanvasFullscreen] = useState(false)
  const [sourcesModalOpen, setSourcesModalOpen] = useState(false)
  const [pivotOpen, setPivotOpen] = useState(false)
  const [pivotRows, setPivotRows] = useState<string[]>([''])
  const [pivotColumn, setPivotColumn] = useState('')
  const [pivotValue, setPivotValue] = useState('')
  const [pivotFallbackValue, setPivotFallbackValue] = useState('')
  const [pivotAgg, setPivotAgg] = useState('first')
  const [formulaOpen, setFormulaOpen] = useState(false)
  const [formulaName, setFormulaName] = useState('')
  const [formulaOperation, setFormulaOperation] = useState('sum')
  const [formulaFields, setFormulaFields] = useState<string[]>([''])
  const [formulaMode, setFormulaMode] = useState<'custom' | 'simple'>('custom')
  const [formulaExpression, setFormulaExpression] = useState('')
  const [editingFormulaIndex, setEditingFormulaIndex] = useState<number | null>(null)
  const [otherTarget, setOtherTarget] = useState('')
  const [compareTarget, setCompareTarget] = useState('')
  const [compareTable, setCompareTable] = useState('')
  const [compareFilters, setCompareFilters] = useState<Source['filters']>([])
  const [compareMetadata, setCompareMetadata] = useState<StructureField[]>([])
  const [compareMetadataLoading, setCompareMetadataLoading] = useState(false)
  const [compareMetadataError, setCompareMetadataError] = useState('')
  const [compareFieldSearch, setCompareFieldSearch] = useState('')
  const [compareFilterMode, setCompareFilterMode] = useState<'all' | 'selected' | 'keys'>('all')
  const [compareSortOrder, setCompareSortOrder] = useState<'sap' | 'selected_first' | 'keys_first' | 'az'>('sap')
  const [compareParameterModalOpen, setCompareParameterModalOpen] = useState(false)
  const [compareRowcount, setCompareRowcount] = useState(100)
  const [compareResult, setCompareResult] = useState<{ left_count: number; right_count: number; complete: boolean; row_limit: number; fields: string[]; key_fields: string[] } | null>(null)
  const [compareRows, setCompareRows] = useState<CompareRow[]>([])
  const [compareView, setCompareView] = useState<'all' | 'same' | 'different'>('all')
  const [compareVariants, setCompareVariants] = useState<CompareVariant[]>([])
  const [compareVariantName, setCompareVariantName] = useState('')
  const [activeCompareVariant, setActiveCompareVariant] = useState('')

  // ==================== UNDO / REDO HISTORY STATES ====================
  const [builderHistoryPast, setBuilderHistoryPast] = useState<BuilderHistoryItem[]>([])
  const [builderHistoryFuture, setBuilderHistoryFuture] = useState<BuilderHistoryItem[]>([])
  const [compareHistoryPast, setCompareHistoryPast] = useState<CompareHistoryItem[]>([])
  const [compareHistoryFuture, setCompareHistoryFuture] = useState<CompareHistoryItem[]>([])

  const isHistoryActionRef = useRef(false)
  const lastBuilderSnapshotRef = useRef<string>('')
  const lastCompareSnapshotRef = useRef<string>('')

  // ==================== AI ASSISTANT STATES ====================
  const [aiModalOpen, setAiModalOpen] = useState(false)
  const [aiContextMode, setAiContextMode] = useState<'builder' | 'compare'>('builder')
  const [aiPrompt, setAiPrompt] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiProgress, setAiProgress] = useState(0)
  const [aiProgressStage, setAiProgressStage] = useState('')
  const [aiError, setAiError] = useState('')
  const [aiProviderStatus, setAiProviderStatus] = useState<AiStatusResponse | null>(null)
  const [aiResult, setAiResult] = useState<AiGenerateResponse | null>(null)

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
  const [reportMenu, setReportMenu] = useState<{
    id: string
    report: Report | SharedReport
    isShared: boolean
    top: number
    left: number
  } | null>(null)
  const reportMenuOpen = reportMenu ? reportMenu.id : null
  const [renameModal, setRenameModal] = useState<{
    open: boolean
    reportId: string
    name: string
    busy: boolean
    error: string
  }>({ open: false, reportId: '', name: '', busy: false, error: '' })

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
      let nextIndex = 0
      while (query.sources.some(source => source.alias === `T${nextIndex + 1}`)) {
        nextIndex++
      }
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
    const [catalog, saved, shared, compVariants] = await Promise.allSettled([
      api<{ resources: Server[] }>('/sap/servers'),
      api<Report[]>('/reports'),
      api<SharedReport[]>('/reports/shared'),
      api<CompareVariant[]>('/compare-variants'),
    ])
    const serverList = catalog.status === 'fulfilled' ? catalog.value.resources : servers
    if (catalog.status === 'fulfilled') {
      const allowed = serverList
      const hasTarget = (id: string) => allowed.some(server => server.id === id)
      setServers(allowed)
      setQuery(q => ({ ...q, target: hasTarget(q.target) ? q.target : allowed[0]?.id || '' }))
      setCompareTarget(t => hasTarget(t) ? t : allowed[0]?.id || '')
      setOtherTarget(t => hasTarget(t) ? t : allowed.find(server => server.id !== (hasTarget(compareTarget) ? compareTarget : allowed[0]?.id))?.id || '')
    }
    const reportList = saved.status === 'fulfilled' ? saved.value : []
    const sharedList = shared.status === 'fulfilled' ? shared.value : []
    if (saved.status === 'fulfilled') {
      setReports(reportList)
    }
    if (shared.status === 'fulfilled') {
      setSharedReports(sharedList)
    }
    const allReports = [...reportList, ...sharedList]
    const lastReportId = localStorage.getItem('lumina_active_report_id')
    const targetReport = allReports.find(r => r.id === lastReportId)
    if (targetReport && !activeReport) {
      await selectReport(targetReport, serverList)
    } else if (!activeReport) {
      setActiveReport(cur => allReports.some(r => r.id === cur) ? cur : '')
    }
    if (compVariants.status === 'fulfilled') setCompareVariants(compVariants.value)
    const failed = [catalog, saved, shared, compVariants].find(x => x.status === 'rejected')
    if (failed?.status === 'rejected') setError(message(failed.reason))
  }

  useEffect(() => {
    function handleUnauthorized(e: Event) {
      const customEvent = e as CustomEvent<string>
      setUser(null)
      setReports([])
      resetWorkspace(false)
      setError(customEvent.detail || 'Sesi telah kedaluwarsa atau tidak valid. Silakan login kembali.')
    }
    window.addEventListener('lumina:unauthorized', handleUnauthorized)

    api<{ user: User }>('/auth/me')
      .then(r => { setUser(r.user); return loadWorkspace() })
      .catch(() => {})
      .finally(() => setLoading(false))

    return () => window.removeEventListener('lumina:unauthorized', handleUnauthorized)
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

  useEffect(() => {
    const timer = window.setTimeout(() => flowRef.current?.fitView({ padding: 0.16, duration: 250 }), 150)
    return () => window.clearTimeout(timer)
  }, [isCanvasFullscreen, sourcesCollapsed])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (shareDropdownRef.current && !shareDropdownRef.current.contains(e.target as unknown as globalThis.Node)) {
        setShareUserDropdownOpen(false)
      }
    }
    if (shareUserDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [shareUserDropdownOpen])

  // ==================== UNDO / REDO HISTORY LOGIC ====================
  const pushBuilderSnapshotImmediate = () => {
    const currentSnapshot: BuilderHistoryItem = {
      query: JSON.parse(JSON.stringify(query)),
      calculatedColumns: JSON.parse(JSON.stringify(calculatedColumns)),
      activePivot: activePivot ? JSON.parse(JSON.stringify(activePivot)) : null,
      visibleColumns: [...visibleColumns],
    }
    const serialized = JSON.stringify(currentSnapshot)
    if (serialized === lastBuilderSnapshotRef.current) return
    setBuilderHistoryPast(prev => [...prev.slice(-35), currentSnapshot])
    setBuilderHistoryFuture([])
    lastBuilderSnapshotRef.current = serialized
  }

  const pushCompareSnapshotImmediate = () => {
    const currentSnapshot: CompareHistoryItem = {
      compareTarget,
      otherTarget,
      compareTable,
      compareRowcount,
      compareFilters: JSON.parse(JSON.stringify(compareFilters)),
    }
    const serialized = JSON.stringify(currentSnapshot)
    if (serialized === lastCompareSnapshotRef.current) return
    setCompareHistoryPast(prev => [...prev.slice(-35), currentSnapshot])
    setCompareHistoryFuture([])
    lastCompareSnapshotRef.current = serialized
  }

  // Automatic debounced tracker for builder state
  useEffect(() => {
    if (isHistoryActionRef.current) {
      isHistoryActionRef.current = false
      return
    }
    const currentSnapshot: BuilderHistoryItem = {
      query,
      calculatedColumns,
      activePivot,
      visibleColumns,
    }
    const serialized = JSON.stringify(currentSnapshot)
    if (!lastBuilderSnapshotRef.current) {
      lastBuilderSnapshotRef.current = serialized
      return
    }
    if (serialized === lastBuilderSnapshotRef.current) return

    const timer = window.setTimeout(() => {
      try {
        const pastItem = JSON.parse(lastBuilderSnapshotRef.current)
        setBuilderHistoryPast(prev => [...prev.slice(-35), pastItem])
        setBuilderHistoryFuture([])
        lastBuilderSnapshotRef.current = serialized
      } catch {}
    }, 600)

    return () => window.clearTimeout(timer)
  }, [query, calculatedColumns, activePivot, visibleColumns])

  // Automatic debounced tracker for compare state
  useEffect(() => {
    if (isHistoryActionRef.current) {
      isHistoryActionRef.current = false
      return
    }
    const currentSnapshot: CompareHistoryItem = {
      compareTarget,
      otherTarget,
      compareTable,
      compareRowcount,
      compareFilters,
    }
    const serialized = JSON.stringify(currentSnapshot)
    if (!lastCompareSnapshotRef.current) {
      lastCompareSnapshotRef.current = serialized
      return
    }
    if (serialized === lastCompareSnapshotRef.current) return

    const timer = window.setTimeout(() => {
      try {
        const pastItem = JSON.parse(lastCompareSnapshotRef.current)
        setCompareHistoryPast(prev => [...prev.slice(-35), pastItem])
        setCompareHistoryFuture([])
        lastCompareSnapshotRef.current = serialized
      } catch {}
    }, 600)

    return () => window.clearTimeout(timer)
  }, [compareTarget, otherTarget, compareTable, compareRowcount, compareFilters])

  // Undo Handler
  const handleUndo = () => {
    if (tab === 'builder') {
      if (builderHistoryPast.length === 0) return
      const currentSnapshot: BuilderHistoryItem = {
        query: JSON.parse(JSON.stringify(query)),
        calculatedColumns: JSON.parse(JSON.stringify(calculatedColumns)),
        activePivot: activePivot ? JSON.parse(JSON.stringify(activePivot)) : null,
        visibleColumns: [...visibleColumns],
      }
      const previous = builderHistoryPast[builderHistoryPast.length - 1]
      isHistoryActionRef.current = true
      setBuilderHistoryPast(prev => prev.slice(0, prev.length - 1))
      setBuilderHistoryFuture(prev => [currentSnapshot, ...prev])

      setQuery(previous.query)
      setCalculatedColumns(previous.calculatedColumns)
      setActivePivot(previous.activePivot)
      setVisibleColumns(previous.visibleColumns)
      lastBuilderSnapshotRef.current = JSON.stringify(previous)
      pushToast({ type: 'info', title: 'Undo', message: 'Perubahan berhasil dibatalkan.' })
    } else if (tab === 'compare') {
      if (compareHistoryPast.length === 0) return
      const currentSnapshot: CompareHistoryItem = {
        compareTarget,
        otherTarget,
        compareTable,
        compareRowcount,
        compareFilters: JSON.parse(JSON.stringify(compareFilters)),
      }
      const previous = compareHistoryPast[compareHistoryPast.length - 1]
      isHistoryActionRef.current = true
      setCompareHistoryPast(prev => prev.slice(0, prev.length - 1))
      setCompareHistoryFuture(prev => [currentSnapshot, ...prev])

      setCompareTarget(previous.compareTarget)
      setOtherTarget(previous.otherTarget)
      setCompareTable(previous.compareTable)
      setCompareRowcount(previous.compareRowcount)
      setCompareFilters(previous.compareFilters)
      lastCompareSnapshotRef.current = JSON.stringify(previous)
      pushToast({ type: 'info', title: 'Undo', message: 'Perubahan perbandingan berhasil dibatalkan.' })
    }
  }

  // Redo Handler
  const handleRedo = () => {
    if (tab === 'builder') {
      if (builderHistoryFuture.length === 0) return
      const currentSnapshot: BuilderHistoryItem = {
        query: JSON.parse(JSON.stringify(query)),
        calculatedColumns: JSON.parse(JSON.stringify(calculatedColumns)),
        activePivot: activePivot ? JSON.parse(JSON.stringify(activePivot)) : null,
        visibleColumns: [...visibleColumns],
      }
      const next = builderHistoryFuture[0]
      isHistoryActionRef.current = true
      setBuilderHistoryFuture(prev => prev.slice(1))
      setBuilderHistoryPast(prev => [...prev, currentSnapshot])

      setQuery(next.query)
      setCalculatedColumns(next.calculatedColumns)
      setActivePivot(next.activePivot)
      setVisibleColumns(next.visibleColumns)
      lastBuilderSnapshotRef.current = JSON.stringify(next)
      pushToast({ type: 'info', title: 'Redo', message: 'Perubahan diterapkan kembali.' })
    } else if (tab === 'compare') {
      if (compareHistoryFuture.length === 0) return
      const currentSnapshot: CompareHistoryItem = {
        compareTarget,
        otherTarget,
        compareTable,
        compareRowcount,
        compareFilters: JSON.parse(JSON.stringify(compareFilters)),
      }
      const next = compareHistoryFuture[0]
      isHistoryActionRef.current = true
      setCompareHistoryFuture(prev => prev.slice(1))
      setCompareHistoryPast(prev => [...prev, currentSnapshot])

      setCompareTarget(next.compareTarget)
      setOtherTarget(next.otherTarget)
      setCompareTable(next.compareTable)
      setCompareRowcount(next.compareRowcount)
      setCompareFilters(next.compareFilters)
      lastCompareSnapshotRef.current = JSON.stringify(next)
      pushToast({ type: 'info', title: 'Redo', message: 'Perubahan perbandingan diterapkan kembali.' })
    }
  }

  // Global Keyboard Listener (Escape, Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z)
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (aiModalOpen) {
          setAiModalOpen(false)
          return
        }
        if (isCanvasFullscreen && !sourcesModalOpen && !relationModal && !catalogModal.open) {
          setIsCanvasFullscreen(false)
        }
        return
      }

      if (!(e.ctrlKey || e.metaKey)) return
      const activeEl = document.activeElement as HTMLElement | null
      const isInput = activeEl && (
        activeEl.tagName === 'INPUT' ||
        activeEl.tagName === 'TEXTAREA' ||
        activeEl.isContentEditable
      )
      if (isInput) return

      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault()
        if (e.shiftKey) {
          handleRedo()
        } else {
          handleUndo()
        }
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault()
        handleRedo()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [aiModalOpen, isCanvasFullscreen, sourcesModalOpen, relationModal, catalogModal.open, tab, builderHistoryPast, builderHistoryFuture, compareHistoryPast, compareHistoryFuture, query, calculatedColumns, activePivot, visibleColumns, compareTarget, otherTarget, compareTable, compareRowcount, compareFilters])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (reportMenu && !(e.target as HTMLElement).closest('.report-menu-btn') && !(e.target as HTMLElement).closest('.report-action-menu')) {
        setReportMenu(null)
      }
      if (userDropdownOpen && !(e.target as HTMLElement).closest('.top-right')) {
        setUserDropdownOpen(false)
      }
    }
    function handleScrollOrResize() {
      if (reportMenu) {
        setReportMenu(null)
      }
    }
    window.addEventListener('click', handleClickOutside)
    window.addEventListener('scroll', handleScrollOrResize, true)
    window.addEventListener('resize', handleScrollOrResize)
    return () => {
      window.removeEventListener('click', handleClickOutside)
      window.removeEventListener('scroll', handleScrollOrResize, true)
      window.removeEventListener('resize', handleScrollOrResize)
    }
  }, [reportMenu, userDropdownOpen])

  // ==================== AI ASSISTANT LOGIC ====================
  const openAiAssistant = (mode: 'builder' | 'compare') => {
    setAiContextMode(mode)
    setAiModalOpen(true)
    setAiError('')
    setAiResult(null)
    setAiProgress(0)
    setAiProgressStage('')
    api<AiStatusResponse>('/ai/status')
      .then(res => setAiProviderStatus(res))
      .catch(() => {})
  }

  const runAiAssistant = async () => {
    if (!aiPrompt.trim() || aiLoading) return
    setAiLoading(true)
    setAiError('')
    setAiResult(null)
    setAiProgress(12)
    setAiProgressStage(aiContextMode === 'builder' ? 'Menganalisis kebutuhan & skema SAP...' : 'Menganalisis kriteria perbandingan...')

    const currentState = aiContextMode === 'compare' ? {
      compareTarget,
      otherTarget,
      compareTable,
      compareRowcount,
      compareFilters,
    } : {
      target: query.target,
      rowcount: query.rowcount,
      sources: query.sources,
      joins: query.joins,
      calculatedColumns,
      pivot: activePivot,
      available_columns: data.columns.length ? data.columns : (baseData.columns.length ? baseData.columns : []),
      visible_columns: visibleColumns.length > 0 ? visibleColumns : (data.columns.length ? data.columns : (baseData.columns.length ? baseData.columns : [])),
      column_descriptions: resultDescriptions,
    }

    const progressStages = aiContextMode === 'builder' ? [
      { target: 28, text: 'Menganalisis tabel SAP & field yang relevan...', delay: 500 },
      { target: 52, text: 'Menyusun relasi join, filter & klausa query...', delay: 1300 },
      { target: 74, text: 'Menghitung kalkulasi kolom & konfigurasi pivot...', delay: 2400 },
      { target: 88, text: 'Menghubungkan ke AI LLM & menyelaraskan JSON...', delay: 3500 },
      { target: 95, text: 'Menyelesaikan respons rancangan sistem...', delay: 5000 },
    ] : [
      { target: 35, text: 'Memeriksa konfigurasi server SAP pembanding...', delay: 500 },
      { target: 65, text: 'Menyusun kriteria tabel dan parameter filter...', delay: 1400 },
      { target: 88, text: 'Menghubungkan ke AI LLM & menyelaraskan JSON...', delay: 2700 },
      { target: 95, text: 'Menyelesaikan respons rancangan sistem...', delay: 4200 },
    ]

    const startTime = Date.now()
    const timer = window.setInterval(() => {
      const elapsed = Date.now() - startTime
      for (let i = progressStages.length - 1; i >= 0; i--) {
        if (elapsed >= progressStages[i].delay) {
          setAiProgress(prev => Math.max(prev, progressStages[i].target))
          setAiProgressStage(progressStages[i].text)
          break
        }
      }
    }, 200)

    try {
      const res = await post<AiGenerateResponse>('/ai/generate', {
        prompt: aiPrompt.trim(),
        context_type: aiContextMode,
        current_state: currentState,
      })
      window.clearInterval(timer)
      setAiProgress(100)
      setAiProgressStage('Rancangan selesai dibuat!')
      await new Promise(r => window.setTimeout(r, 260))
      setAiResult(res)
    } catch (err) {
      window.clearInterval(timer)
      setAiError(message(err))
    } finally {
      window.clearInterval(timer)
      setAiLoading(false)
    }
  }

  const applyAiResult = () => {
    if (!aiResult) return
    const aiData = aiResult.data

    if (aiContextMode === 'builder') {
      pushBuilderSnapshotImmediate()

      // 1. Process sources
      const rawSources = aiData.sources || []
      const newSources: Source[] = rawSources.length > 0 ? rawSources.map((s, idx) => ({
        alias: s.alias || `T${idx + 1}`,
        table_name: (s.table_name || '').toUpperCase().trim(),
        fields: Array.isArray(s.fields) ? s.fields.map(f => String(f).toUpperCase().trim()) : [],
        filters: Array.isArray(s.filters) ? s.filters.map(f => ({
          field: String(f.field).toUpperCase().trim(),
          operator: f.operator || 'EQ',
          value: String(f.value || ''),
          high_value: f.high_value ? String(f.high_value) : '',
          sign: f.sign || 'I',
        })) : [],
      })) : query.sources

      // 2. Process joins
      const rawJoins = aiData.joins || []
      const newJoins: Join[] = rawJoins.map(j => {
        const conds = Array.isArray(j.conditions) && j.conditions.length > 0
          ? j.conditions.map(c => ({ left_field: String(c.left_field).toUpperCase().trim(), right_field: String(c.right_field).toUpperCase().trim() }))
          : [{ left_field: String(j.left_field || '').toUpperCase().trim(), right_field: String(j.right_field || '').toUpperCase().trim() }]
        return {
          left_alias: j.left_alias,
          right_alias: j.right_alias,
          how: j.how || 'left',
          left_field: conds[0]?.left_field || '',
          right_field: conds[0]?.right_field || '',
          conditions: conds,
          manual: true,
        }
      })

      // 3. Process calculated columns
      const rawCalcs = aiData.calculatedColumns || []
      const newCalcs: CalculatedColumn[] = rawCalcs.map(c => ({
        name: (c.name || 'CALC').toUpperCase().trim(),
        operation: c.operation || 'custom',
        expression: c.expression || '',
        fields: c.fields || [],
      }))

      // 4. Process pivot
      let newPivot: PivotConfig | null = null
      if (aiData.pivot && aiData.pivot.column && aiData.pivot.value) {
        newPivot = {
          rows: Array.isArray(aiData.pivot.rows) ? aiData.pivot.rows : [aiData.pivot.rows],
          column: aiData.pivot.column,
          value: aiData.pivot.value,
          fallback_value: aiData.pivot.fallback_value || '',
          aggregation: aiData.pivot.aggregation || 'first',
        }
        setPivotRows(newPivot.rows)
        setPivotColumn(newPivot.column)
        setPivotValue(newPivot.value)
        setPivotFallbackValue(newPivot.fallback_value || '')
        setPivotAgg(newPivot.aggregation)
      } else {
        setActivePivot(null)
      }

      // 5. Target & rowcount
      const targetServer = (aiData.target && servers.some(s => s.id === aiData.target))
        ? aiData.target
        : (query.target || servers[0]?.id || '')
      const newRowcount = Number(aiData.rowcount) || query.rowcount || 100

      const updatedQuery: Query = {
        target: targetServer,
        rowcount: newRowcount,
        sources: newSources,
        joins: newJoins,
      }

      setQuery(updatedQuery)
      setCalculatedColumns(newCalcs)
      if (newPivot) setActivePivot(newPivot)
      const targetPivot = newPivot !== null ? newPivot : activePivot

      // 5. Apply ALV row sort if returned by AI
      if (aiData.sort && aiData.sort.column) {
        setResultSortCol(aiData.sort.column)
        setResultSortDir(aiData.sort.direction || 'asc')
      }

      // 6. Apply ALV visible columns / column order
      const hasAiVisible = Array.isArray(aiData.visibleColumns) && aiData.visibleColumns.length > 0
      const initialVis = hasAiVisible ? aiData.visibleColumns! : visibleColumns
      setVisibleColumns(initialVis)

      if (baseData.rows.length > 0) {
        applyPresentation(baseData, newCalcs, targetPivot).then(res => {
          setData(res)
          const calcNames = newCalcs.map(c => c.name)
          let finalVis = hasAiVisible
            ? aiData.visibleColumns!.filter(c => res.columns.includes(c))
            : (visibleColumns.length > 0 ? visibleColumns.filter(c => res.columns.includes(c)) : res.columns)
          // Make sure calculated columns are visible
          calcNames.forEach(cn => {
            if (res.columns.includes(cn) && !finalVis.includes(cn)) {
              finalVis.push(cn)
            }
          })
          setVisibleColumns(finalVis)
        }).catch(() => {})
      }

      if (activeReport && activeSharedPermission !== 'view') {
        const definition: ReportDefinition = {
          ...updatedQuery,
          presentation: {
            pivot: targetPivot,
            calculatedColumns: newCalcs,
            visibleColumns: initialVis,
          },
        }
        api(`/reports/${encodeURIComponent(activeReport)}`, {
          method: 'PUT', body: JSON.stringify({ name: reportName, definition }),
        }).catch(() => {})
        setReports(prev => prev.map(r => r.id === activeReport ? { ...r, definition } : r))
      }
      setAiModalOpen(false)

      pushToast({
        type: 'success',
        title: 'Asisten AI Diterapkan',
        message: 'Konfigurasi query, kolom ALV, kalkulasi & pivot berhasil diterapkan ke workspace! Tekan Ctrl+Z untuk membatalkan (Undo).',
      })
    } else if (aiContextMode === 'compare') {
      pushCompareSnapshotImmediate()

      if (aiData.target && servers.some(s => s.id === aiData.target)) {
        setCompareTarget(aiData.target)
      }
      if (aiData.other_target && servers.some(s => s.id === aiData.other_target)) {
        setOtherTarget(aiData.other_target)
      }
      if (aiData.table_name) {
        setCompareTable(aiData.table_name.toUpperCase().trim())
      }
      if (aiData.rowcount) {
        setCompareRowcount(Number(aiData.rowcount))
      }
      if (Array.isArray(aiData.filters)) {
        setCompareFilters(aiData.filters.map(f => ({
          field: String(f.field).toUpperCase().trim(),
          operator: f.operator || 'EQ',
          value: String(f.value || ''),
          high_value: f.high_value ? String(f.high_value) : '',
          sign: f.sign || 'I',
        })))
      }
      setAiModalOpen(false)

      pushToast({
        type: 'success',
        title: 'Asisten AI Diterapkan',
        message: 'Pengaturan perbandingan data berhasil diterapkan ke form!',
      })
    }
  }

  function resetWorkspace(recordHistory: boolean = true) {
    if (recordHistory) {
      pushBuilderSnapshotImmediate()
    }
    setRelationModal(null)
    setActiveReport('')
    localStorage.removeItem('lumina_active_report_id')
    setReportName('')
    setQuery({
      target: servers[0]?.id || '',
      sources: [blankSource(0)],
      joins: [],
      rowcount: 100,
    })
    setData({ columns: [], rows: [] })
    setBaseData({ columns: [], rows: [] })
    setCalculatedColumns([])
    setActivePivot(null)
    setPivotRows([''])
    setPivotColumn('')
    setPivotValue('')
    setPivotFallbackValue('')
    setPivotAgg('first')
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
      resetWorkspace(false)
      await loadWorkspace()
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  async function doLogout() {
    await post('/auth/logout', {}).catch(() => {})
    setUser(null); setReports([])
    resetWorkspace(false)
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

  function openSelectionDialog(sourceIndexOrNull: number | null, field: string, context: 'query' | 'compare' = 'query', tableName?: string) {
    const filters = context === 'compare'
      ? compareFilters.filter(filter => filter.field === field)
      : query.sources[sourceIndexOrNull ?? 0].filters.filter(filter => filter.field === field)
    const entries = {} as Record<SelectionTab, string>
    for (const [tab, sign, operator] of [
      ['include_values', 'I', 'EQ'], ['include_ranges', 'I', 'BT'],
      ['exclude_values', 'E', 'EQ'], ['exclude_ranges', 'E', 'BT'],
    ] as const) {
      entries[tab] = filters.filter(filter => (filter.sign || 'I') === sign && filter.operator === operator)
        .map(filter => operator === 'BT' ? `${filter.value}\t${filter.high_value || ''}` : filter.value).join('\n')
    }
    setSelectionDialog({
      sourceIndex: sourceIndexOrNull ?? undefined,
      context,
      field,
      tableName: tableName || (context === 'compare' ? compareTable : query.sources[sourceIndexOrNull ?? 0]?.table_name),
      tab: 'include_values',
      entries,
    })
  }

  function saveSelectionDialog() {
    if (!selectionDialog) return
    const { sourceIndex, field, entries, context } = selectionDialog
    const isCompare = context === 'compare'
    const existingFilters = isCompare ? compareFilters : query.sources[sourceIndex ?? 0].filters
    const selected: Source['filters'] = []
    for (const [tab, sign, operator] of [
      ['include_values', 'I', 'EQ'], ['include_ranges', 'I', 'BT'],
      ['exclude_values', 'E', 'EQ'], ['exclude_ranges', 'E', 'BT'],
    ] as const) {
      for (const raw of entries[tab].split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
        if (operator === 'BT') {
          const [value, high_value, ...rest] = raw.split(/[\t;,]/).map(value => value.trim())
          if (!value || !high_value || rest.length) { setError('Interval harus berisi dua nilai per baris, dipisahkan Tab, titik koma, atau koma.'); return }
          selected.push({ field, operator, value, high_value, sign })
        } else {
          for (const value of raw.split(/[\t;,]/).map(value => value.trim()).filter(Boolean)) {
            selected.push({ field, operator, value, sign })
          }
        }
      }
    }
    const retained = existingFilters.filter(filter => filter.field !== field || !['EQ', 'BT'].includes(filter.operator))
    if (retained.length + selected.length > 30) { setError('Maksimal 30 pilihan per tabel.'); return }
    if (isCompare) {
      setCompareFilters([...retained, ...selected])
    } else {
      updateSource(sourceIndex ?? 0, { filters: [...retained, ...selected] })
    }
    setSelectionDialog(null)
    setError('')
  }

  function addSource() {
    let nextIndex = 0
    while (query.sources.some(source => source.alias === `T${nextIndex + 1}`)) {
      nextIndex++
    }
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
    pushBuilderSnapshotImmediate()
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

  function handleRunQueryClick() {
    const hasFilters = query.sources.some(s => s.filters.length > 0)
    if (hasFilters) {
      setParameterModalOpen(true)
    } else {
      runQuery()
    }
  }

  async function runQuery(): Promise<boolean> {
    if (!query.sources.some(source => source.fields.length)) {
      setError('Pilih setidaknya satu kolom Tampil sebelum menjalankan query.')
      return false
    }
    if (query.joins.some(join => !(join.conditions?.length || (join.left_field && join.right_field)))) {
      setError('Lengkapi relasi join antar tabel sebelum menjalankan query.')
      return false
    }
    setBusy(true); setError(''); setNotice('')
    try {
      const validReportId = reports.some(r => r.id === activeReport) ? activeReport : null
      const result = await post<GridData>('/sap/query', { ...query, report_id: validReportId })
      setBaseData(result)
      const availableForPivot = [...result.columns, ...calculatedColumns.map(c => c.name)]
      const pivot = activePivot && availableForPivot.includes(activePivot.column) && availableForPivot.includes(activePivot.value)
        ? {
            ...activePivot,
            rows: activePivot.rows.filter(column => availableForPivot.includes(column)),
          }
        : null
      const displayed = await applyPresentation(result, calculatedColumns, pivot)
      if (pivot && pivot.rows.length) {
        setActivePivot(pivot)
        setPivotRows(pivot.rows)
        setPivotFallbackValue(pivot.fallback_value || '')
      } else if (activePivot && !pivot) {
        setActivePivot(null)
        setPivotRows([''])
        setPivotFallbackValue('')
      }
      setData(displayed)
      setVisibleColumns(current => {
        const calcNames = calculatedColumns.map(c => c.name)
        if (current.length === 0) return displayed.columns
        const savedMatches = current.filter(column => displayed.columns.includes(column))
        const newCalcs = calcNames.filter(name => displayed.columns.includes(name) && !savedMatches.includes(name))
        return savedMatches.length > 0 ? [...savedMatches, ...newCalcs] : displayed.columns
      })
      setNotice(`${result.rows.length.toLocaleString('id-ID')} baris berhasil dimuat` +
        (activePivot && !pivot ? ' · Pivot dilepas karena kolom pengaturannya sudah tidak ada pada query.' : '') +
        (result.warnings?.length ? ` · ${result.warnings.join(' ')}` : ''))
      window.setTimeout(() => {
        queryResultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
      return true
    } catch (e) {
      setError(message(e))
      return false
    }
    finally { setBusy(false) }
  }

  async function applyPresentation(raw: GridData, calculations: CalculatedColumn[], pivot: PivotConfig | null): Promise<GridData> {
    let result = raw
    if (!result.rows.length) return result

    function resolveCol(colName: string, availableCols: string[]): string | null {
      if (availableCols.includes(colName)) return colName
      const upper = colName.toUpperCase()
      const ci = availableCols.find(c => c.toUpperCase() === upper)
      if (ci) return ci
      const aliasMatch = availableCols.find(c => c.split('.').pop()?.toUpperCase() === upper || colName.split('.').pop()?.toUpperCase() === c.toUpperCase())
      if (aliasMatch) return aliasMatch
      const sub = availableCols.filter(c => c.toUpperCase().includes(upper))
      if (sub.length === 1) return sub[0]
      const revSub = availableCols.filter(c => upper.includes(c.toUpperCase()))
      if (revSub.length === 1) return revSub[0]
      return null
    }

    // 1. Run calculations on pre-pivot columns first
    const remainingCalcs: CalculatedColumn[] = []
    for (const column of calculations) {
      const rawReq = column.expression
        ? (column.expression.match(/\[([^\]]+)\]/g)?.map(m => m.slice(1, -1)) || [])
        : (column.fields || [])
      const resolvedCols = rawReq.map(f => resolveCol(f, result.columns))
      if (resolvedCols.length > 0 && resolvedCols.every((f): f is string => f !== null)) {
        let colPayload = { ...column }
        if (column.expression) {
          let newExpr = column.expression
          rawReq.forEach((oldCol, idx) => {
            const newCol = resolvedCols[idx]
            if (newCol && oldCol !== newCol) {
              newExpr = newExpr.split(`[${oldCol}]`).join(`[${newCol}]`)
            }
          })
          colPayload.expression = newExpr
        } else if (column.fields) {
          colPayload.fields = resolvedCols as string[]
        }
        result = await post<GridData>('/data/calculated-column', { rows: result.rows, ...colPayload })
      } else {
        remainingCalcs.push(column)
      }
    }

    // 2. Apply pivot if configured
    if (pivot) {
      const available = new Set(result.columns)
      const rows = pivot.rows.filter(column => available.has(column))
      if (rows.length && available.has(pivot.column) && available.has(pivot.value)) {
        result = await post<GridData>('/data/pivot', {
          rows: result.rows,
          index: rows,
          columns: pivot.column,
          values: pivot.value,
          fallback_values: (pivot.fallback_value && available.has(pivot.fallback_value)) ? pivot.fallback_value : undefined,
          aggregation: pivot.aggregation,
        })
      }
    }

    // 3. Run remaining calculations on post-pivot columns
    for (const column of remainingCalcs) {
      const rawReq = column.expression
        ? (column.expression.match(/\[([^\]]+)\]/g)?.map(m => m.slice(1, -1)) || [])
        : (column.fields || [])
      const resolvedCols = rawReq.map(f => resolveCol(f, result.columns))
      if (resolvedCols.length > 0 && resolvedCols.every((f): f is string => f !== null)) {
        let colPayload = { ...column }
        if (column.expression) {
          let newExpr = column.expression
          rawReq.forEach((oldCol, idx) => {
            const newCol = resolvedCols[idx]
            if (newCol && oldCol !== newCol) {
              newExpr = newExpr.split(`[${oldCol}]`).join(`[${newCol}]`)
            }
          })
          colPayload.expression = newExpr
        } else if (column.fields) {
          colPayload.fields = resolvedCols as string[]
        }
        result = await post<GridData>('/data/calculated-column', { rows: result.rows, ...colPayload })
      }
    }

    return result
  }

  async function runPivot() {
    const rows = pivotRows.filter(Boolean)
    if (!rows.length || !pivotColumn || !pivotValue || new Set([...rows, pivotColumn, pivotValue]).size !== rows.length + 2) {
      setError('Pilih field Baris, Kolom, dan Nilai yang berbeda.'); return
    }
    const checkColumns = [...rows, pivotColumn, pivotValue, ...(pivotFallbackValue ? [pivotFallbackValue] : [])]
    const unavailable = checkColumns.filter(column => !sourceColumns.includes(column))
    if (unavailable.length) {
      setError(`Kolom pivot sudah tidak tersedia: ${unavailable.join(', ')}. Pilih ulang pengaturan pivot.`)
      return
    }
    setBusy(true); setError('')
    try {
      pushBuilderSnapshotImmediate()
      const config: PivotConfig = {
        rows,
        column: pivotColumn,
        value: pivotValue,
        fallback_value: pivotFallbackValue || undefined,
        aggregation: pivotAgg,
      }
      const result = await applyPresentation(baseData, calculatedColumns, config)
      setActivePivot(config)
      setData(result); setVisibleColumns(result.columns); setPivotOpen(false)
      if (activeReport && activeSharedPermission !== 'view') {
        const definition: ReportDefinition = {
          ...query,
          presentation: {
            pivot: config,
            calculatedColumns,
            visibleColumns: result.columns,
          },
        }
        api(`/reports/${encodeURIComponent(activeReport)}`, {
          method: 'PUT',
          body: JSON.stringify({ name: reportName, definition }),
        }).catch(() => {})
        setReports(prev => prev.map(r => r.id === activeReport ? { ...r, definition } : r))
      }
      setNotice('Data berhasil di-pivot.')
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  function openFormulaModal(editIndex: number | null = null) {
    if (editIndex !== null && calculatedColumns[editIndex]) {
      const existing = calculatedColumns[editIndex]
      setEditingFormulaIndex(editIndex)
      setFormulaName(existing.name)
      if (existing.expression) {
        setFormulaMode('custom')
        setFormulaExpression(existing.expression)
        setFormulaOperation('custom')
        setFormulaFields([''])
      } else {
        setFormulaMode('simple')
        setFormulaOperation(existing.operation || 'sum')
        setFormulaFields(existing.fields?.length ? existing.fields : [''])
        setFormulaExpression('')
      }
    } else {
      setEditingFormulaIndex(null)
      setFormulaName('')
      setFormulaMode('custom')
      setFormulaExpression('')
      setFormulaOperation('sum')
      setFormulaFields([''])
    }
    setFormulaOpen(true)
  }

  async function removeCalculatedColumn(index: number) {
    const target = calculatedColumns[index]
    if (!target) return
    pushBuilderSnapshotImmediate()
    setBusy(true); setError('')
    try {
      const updated = calculatedColumns.filter((_, i) => i !== index)
      const result = await applyPresentation(baseData, updated, activePivot)
      setCalculatedColumns(updated)
      setData(result)
      let nextVisible = visibleColumns.filter(c => c !== target.name)
      if (result.columns.length > 0) {
        nextVisible = visibleColumns.length > 0
          ? visibleColumns.filter(c => result.columns.includes(c) && c !== target.name)
          : result.columns
      }
      setVisibleColumns(nextVisible)
      if (editingFormulaIndex === index) {
        openFormulaModal(null)
      }
      if (activeReport && activeSharedPermission !== 'view') {
        const definition: ReportDefinition = {
          ...query,
          presentation: {
            pivot: activePivot,
            calculatedColumns: updated,
            visibleColumns: nextVisible,
          },
        }
        api(`/reports/${encodeURIComponent(activeReport)}`, {
          method: 'PUT',
          body: JSON.stringify({ name: reportName, definition }),
        }).catch(() => {})
        setReports(prev => prev.map(r => r.id === activeReport ? { ...r, definition } : r))
      }
      setNotice(`Kolom hitung "${target.name}" berhasil dihapus.`)
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  async function runFormula() {
    const name = formulaName.trim()
    if (!name) {
      setError('Isi nama kolom hasil.')
      return
    }

    pushBuilderSnapshotImmediate()
    let calculation: CalculatedColumn
    if (formulaMode === 'custom') {
      const expr = formulaExpression.trim()
      if (!expr) {
        setError('Tuliskan rumus formula (contoh: ([KolomA] * [KolomB]) / 1000).')
        return
      }
      const refCols = expr.match(/\[([^\]]+)\]/g)?.map(m => m.slice(1, -1)) || []
      if (!refCols.length) {
        setError('Rumus harus menyertakan setidaknya satu kolom sumber dalam tanda kurung siku [Kolom].')
        return
      }
      calculation = { name, operation: 'custom', expression: expr }
    } else {
      const fields = formulaFields.filter(Boolean)
      if (formulaOperation === 'divide' && fields.length !== 2) {
        setError('Operasi pembagian (÷) memerlukan tepat 2 kolom sumber.')
        return
      }
      if (fields.length < (['sum', 'average', 'subtract', 'multiply'].includes(formulaOperation) ? 2 : 1)) {
        setError('Pilih minimal 2 kolom sumber.')
        return
      }
      if (new Set(fields).size !== fields.length) {
        setError('Pilih kolom sumber yang berbeda.')
        return
      }
      calculation = { name, operation: formulaOperation, fields }
    }

    setBusy(true); setError('')
    try {
      let updated: CalculatedColumn[]
      if (editingFormulaIndex !== null && editingFormulaIndex >= 0 && editingFormulaIndex < calculatedColumns.length) {
        updated = calculatedColumns.map((c, i) => i === editingFormulaIndex ? calculation : c)
      } else {
        updated = [...calculatedColumns, calculation]
      }
      const result = await applyPresentation(baseData, updated, activePivot)
      setCalculatedColumns(updated)
      setData(result)
      let nextVisible = visibleColumns
      if (result.columns.length > 0) {
        nextVisible = visibleColumns.length > 0
          ? Array.from(new Set([...visibleColumns.filter(c => result.columns.includes(c)), name]))
          : result.columns
      } else if (visibleColumns.length > 0 && !visibleColumns.includes(name)) {
        nextVisible = [...visibleColumns, name]
      }
      setVisibleColumns(nextVisible)
      if (activeReport && activeSharedPermission !== 'view') {
        const definition: ReportDefinition = {
          ...query,
          presentation: {
            pivot: activePivot,
            calculatedColumns: updated,
            visibleColumns: nextVisible,
          },
        }
        api(`/reports/${encodeURIComponent(activeReport)}`, {
          method: 'PUT',
          body: JSON.stringify({ name: reportName, definition }),
        }).catch(() => {})
        setReports(prev => prev.map(r => r.id === activeReport ? { ...r, definition } : r))
      }
      setFormulaOpen(false)
      setFormulaName('')
      setFormulaExpression('')
      setFormulaFields([''])
      setEditingFormulaIndex(null)
      setNotice(editingFormulaIndex !== null ? `Kolom "${name}" berhasil diperbarui.` : `Kolom "${name}" berhasil ditambahkan.`)
    } catch (e) { setError(message(e)) }
    finally { setBusy(false) }
  }

  function handleRunCompareClick() {
    if (!compareTarget || !otherTarget || compareTarget === otherTarget) {
      setError('Pilih dua server SAP yang berbeda.')
      return
    }
    if (!compareTable.trim()) {
      setError('Isi nama tabel yang akan dibandingkan.')
      return
    }
    if (compareFilters.length > 0) {
      setCompareParameterModalOpen(true)
    } else {
      runCompare()
    }
  }

  async function runCompare(): Promise<boolean> {
    if (!compareTarget || !otherTarget || compareTarget === otherTarget) { setError('Pilih dua server SAP yang berbeda.'); return false }
    if (!compareTable.trim()) { setError('Isi nama tabel yang akan dibandingkan.'); return false }
    if (compareFilters.some(filter => !filter.field.trim())) { setError('Isi field untuk setiap filter.'); return false }
    if (!Number.isInteger(compareRowcount) || compareRowcount < 1 || compareRowcount > 1000) { setError('Batas baris harus 1–1000.'); return false }
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
      return true
    } catch (e) {
      setError(message(e))
      return false
    }
    finally { setBusy(false) }
  }

  async function saveReport() {
    const name = reportName.trim()
    if (!name) { setError('Isi nama laporan.'); return }
    if (activeSharedPermission === 'view') {
      setError('Laporan ini dibagikan dengan hak akses hanya melihat (View). Gunakan "Simpan Sebagai Salinan Baru" untuk menyimpan salinan ke laporan milik Anda sendiri.')
      return
    }
    setBusy(true); setError('')
    try {
      const definition: ReportDefinition = { ...query, presentation: { pivot: activePivot, calculatedColumns, visibleColumns } }
      if (activeReport) {
        const saved = await api<{ id: string }>(`/reports/${encodeURIComponent(activeReport)}`, {
          method: 'PUT', body: JSON.stringify({ name, definition }),
        })
        setActiveReport(saved.id)
        localStorage.setItem('lumina_active_report_id', saved.id)
        setNotice(`Laporan "${name}" berhasil diperbarui.`)
      } else {
        const saved = await post<{ id: string }>('/reports', { name, definition })
        setActiveReport(saved.id)
        setActiveSharedPermission('owner')
        localStorage.setItem('lumina_active_report_id', saved.id)
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
      const saved = await post<{ id: string }>('/reports', { name, definition: { ...query, presentation: { pivot: activePivot, calculatedColumns, visibleColumns } } })
      setActiveReport(saved.id)
      setActiveSharedPermission('owner')
      localStorage.setItem('lumina_active_report_id', saved.id)
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
            localStorage.removeItem('lumina_active_report_id')
            resetWorkspace()
          }
          await loadWorkspace()
          setNotice(`Laporan "${name}" berhasil dihapus.`)
        } catch (e) { setError(message(e)) }
        finally { setBusy(false) }
      },
    })
  }

  function handleToggleReportMenu(e: React.MouseEvent<HTMLButtonElement>, targetReport: Report | SharedReport, isShared: boolean) {
    e.stopPropagation()
    if (reportMenu?.id === targetReport.id) {
      setReportMenu(null)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    const menuWidth = 155
    const menuHeight = isShared ? 48 : 138

    // Posisi vertikal: jika ruang di bawah tidak cukup, tampilkan ke atas
    const spaceBelow = window.innerHeight - rect.bottom
    let top = rect.bottom + 4
    if (spaceBelow < menuHeight && rect.top > menuHeight) {
      top = rect.top - menuHeight - 4
    } else if (top + menuHeight > window.innerHeight) {
      top = Math.max(10, window.innerHeight - menuHeight - 10)
    }

    let left = rect.right - menuWidth
    if (left < 10) left = 10

    setReportMenu({
      id: targetReport.id,
      report: targetReport,
      isShared,
      top,
      left,
    })
  }

  function openRenameModal(report: { id: string; name: string }) {
    setRenameModal({ open: true, reportId: report.id, name: report.name, busy: false, error: '' })
  }

  async function handleRenameSubmit(e?: React.FormEvent) {
    if (e) e.preventDefault()
    const trimmed = renameModal.name.trim()
    if (!trimmed) {
      setRenameModal(prev => ({ ...prev, error: 'Nama laporan tidak boleh kosong.' }))
      return
    }
    setRenameModal(prev => ({ ...prev, busy: true, error: '' }))
    try {
      await api(`/reports/${encodeURIComponent(renameModal.reportId)}/rename`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      })
      if (activeReport === renameModal.reportId) {
        setReportName(trimmed)
      }
      setReports(prev => prev.map(r => r.id === renameModal.reportId ? { ...r, name: trimmed } : r))
      setSharedReports(prev => prev.map(sr => sr.id === renameModal.reportId ? { ...sr, name: trimmed } : sr))
      setNotice(`Nama laporan berhasil diubah menjadi "${trimmed}".`)
      setRenameModal({ open: false, reportId: '', name: '', busy: false, error: '' })
    } catch (err) {
      setRenameModal(prev => ({ ...prev, busy: false, error: message(err) }))
    }
  }

  async function selectReport(report: Report | SharedReport, serverList: Server[] = servers) {
    pushBuilderSnapshotImmediate()
    setRelationModal(null)
    const availableServers = serverList.length ? serverList : servers
    const targetAllowed = availableServers.some(server => server.id === report.definition.target)
    setQuery({ ...report.definition, target: targetAllowed ? report.definition.target : '' })
    const presentation = report.definition.presentation
    setActivePivot(presentation?.pivot || null)
    setCalculatedColumns(presentation?.calculatedColumns || [])
    setPivotRows(presentation?.pivot?.rows?.length ? presentation.pivot.rows : [''])
    setPivotColumn(presentation?.pivot?.column || '')
    setPivotValue(presentation?.pivot?.value || '')
    setPivotFallbackValue(presentation?.pivot?.fallback_value || '')
    setPivotAgg(presentation?.pivot?.aggregation || 'first')
    if (!targetAllowed) setNotice('Server pada laporan ini tidak tersedia untuk akun Anda. Pilih server yang diizinkan sebelum menjalankan.')
    setActiveReport(report.id); setTab('builder')
    setReportName(report.name)
    setActiveSharedPermission('permission' in report ? report.permission : 'owner')
    localStorage.setItem('lumina_active_report_id', report.id)
    setFieldText({}); setStructureFields({}); setStructureKeys({}); setStructureText({})
    setData({ columns: [], rows: [] }); setBaseData({ columns: [], rows: [] }); setVisibleColumns(presentation?.visibleColumns || [])
    try { setVariants(await api<typeof variants>(`/reports/${report.id}/variants`)) }
    catch (e) { setError(message(e)) }
  }

  async function openShareModal(report: Report) {
    setShareModal({
      open: true,
      report,
      shares: [],
      loading: true,
      targetUsername: '',
      permission: 'view',
      saving: false,
      error: '',
    })
    try {
      const [sharesRes, usersRes] = await Promise.all([
        api<ReportShareItem[]>(`/reports/${encodeURIComponent(report.id)}/shares`),
        api<AvailableUser[]>('/users'),
      ])
      setShareModal(prev => ({
        ...prev,
        shares: sharesRes,
        loading: false,
      }))
      setAvailableUsers(usersRes)
    } catch (e) {
      setShareModal(prev => ({
        ...prev,
        loading: false,
        error: message(e),
      }))
    }
  }

  async function handleAddShare() {
    if (!shareModal.report) return
    const username = shareModal.targetUsername.trim()
    if (!username) {
      setShareModal(prev => ({ ...prev, error: 'Pilih atau masukkan username penerima.' }))
      return
    }
    setShareModal(prev => ({ ...prev, saving: true, error: '' }))
    try {
      await post<ReportShareItem>(`/reports/${encodeURIComponent(shareModal.report.id)}/shares`, {
        username,
        permission: shareModal.permission,
      })
      const sharesRes = await api<ReportShareItem[]>(`/reports/${encodeURIComponent(shareModal.report.id)}/shares`)
      setShareModal(prev => ({
        ...prev,
        shares: sharesRes,
        targetUsername: '',
        saving: false,
      }))
      pushToast({
        type: 'success',
        title: 'Berhasil Membagikan',
        message: `Laporan dibagikan ke ${username} dengan hak ${shareModal.permission === 'edit' ? 'Edit' : 'View'}.`,
      })
    } catch (e) {
      setShareModal(prev => ({ ...prev, saving: false, error: message(e) }))
    }
  }

  async function handleRemoveShare(shareId: string, username: string) {
    if (!shareModal.report) return
    setShareModal(prev => ({ ...prev, saving: true, error: '' }))
    try {
      await api(`/reports/${encodeURIComponent(shareModal.report.id)}/shares/${encodeURIComponent(shareId)}`, {
        method: 'DELETE',
      })
      const sharesRes = await api<ReportShareItem[]>(`/reports/${encodeURIComponent(shareModal.report.id)}/shares`)
      setShareModal(prev => ({
        ...prev,
        shares: sharesRes,
        saving: false,
      }))
      pushToast({
        type: 'info',
        title: 'Akses Dicabut',
        message: `Akses sharing untuk ${username} telah dicabut.`,
      })
    } catch (e) {
      setShareModal(prev => ({ ...prev, saving: false, error: message(e) }))
    }
  }

  async function handleUpdateSharePermission(share: ReportShareItem, newPermission: 'view' | 'edit') {
    if (!shareModal.report || share.permission === newPermission) return
    setShareModal(prev => ({ ...prev, saving: true, error: '' }))
    try {
      await post<ReportShareItem>(`/reports/${encodeURIComponent(shareModal.report.id)}/shares`, {
        username: share.shared_with_username,
        permission: newPermission,
      })
      const sharesRes = await api<ReportShareItem[]>(`/reports/${encodeURIComponent(shareModal.report.id)}/shares`)
      setShareModal(prev => ({
        ...prev,
        shares: sharesRes,
        saving: false,
      }))
      pushToast({
        type: 'success',
        title: 'Hak Akses Diperbarui',
        message: `Hak akses ${share.shared_with_username} diubah menjadi ${newPermission === 'edit' ? 'Edit' : 'View'}.`,
      })
    } catch (e) {
      setShareModal(prev => ({ ...prev, saving: false, error: message(e) }))
    }
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

  function moveVisibleColumn(column: string, target: string) {
    setVisibleColumns(current => {
      if (column === target || !current.includes(column) || !current.includes(target)) return current
      const next = current.filter(item => item !== column)
      next.splice(next.indexOf(target), 0, column)
      return next
    })
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
        body: JSON.stringify({ rows: data.rows.map(row => Object.fromEntries(visibleColumns.map(column => [column, row[column]]))), mask_fields: [], drop_duplicates: false }),
      })
      if (!res.ok) throw new Error('Ekspor gagal.')
      const url = URL.createObjectURL(await res.blob())
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = 'lumina-report.xlsx'; anchor.click()
      URL.revokeObjectURL(url)
    } catch (e) { setError(message(e)) }
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
      setNotice('Password akun berhasil diperbarui.')
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


  const resultDescriptions = useMemo(() => Object.fromEntries(query.sources.flatMap(source => (structureFields[source.alias] || []).map(field => [`${source.alias}.${field.name}`, field.description || '']))), [query.sources, structureFields])
  const queryFieldColumns = useMemo(() => query.sources.flatMap(s => s.fields.map(f => `${s.alias}.${f.toUpperCase()}`)), [query.sources])
  const sourceColumns = useMemo(() => {
    const raw = baseData.columns.length ? baseData.columns : queryFieldColumns
    return Array.from(new Set([...raw, ...calculatedColumns.map(column => column.name)]))
  }, [baseData.columns, queryFieldColumns, calculatedColumns])
  const formulaSourceColumns = useMemo(() => {
    if (activePivot && data.columns.length > 0) {
      return data.columns
    }
    return sourceColumns
  }, [activePivot, data.columns, sourceColumns])
  const columns = useMemo<ColDef<Row>[]>(() => visibleColumns
    .filter(c => data.columns.includes(c))
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

  function renderSourceForms() {
    return query.sources.map((source, index) => (
      <div className="source-form" key={index}>
        <div className="source-title">
          <span className="source-badge">{index + 1}</span>
          <strong>Tabel {source.alias}</strong>
          {index > 0 && (
            <button className="icon-button" title="Hapus tabel" onClick={() => removeSource(index)}>
              <Trash2 size={15} />
            </button>
          )}
        </div>
        <label>
          Nama tabel
          <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <input
              placeholder="Contoh: MARA"
              value={source.table_name}
              onChange={e => updateSource(index, { table_name: e.target.value.toUpperCase() })}
            />
            <button
              className="button subtle"
              style={{ padding: '0.45rem 0.6rem', height: '36px', whiteSpace: 'nowrap' }}
              onClick={() => openTableCatalog(index)}
              title="Cari di katalog tabel SAP"
            >
              <BookOpen size={14} /> Katalog
            </button>
          </div>
        </label>
        <small className="metadata-status">
          {structureLoading[source.alias]
            ? 'Memuat struktur tabel…'
            : metadataFor(source).length
              ? `${metadataFor(source).length} kolom tersedia di canvas`
              : 'Isi nama tabel; kolom akan dimuat otomatis.'}
        </small>
        {metadataFor(source).length > 0 && !metadataFor(source).some(field => field.description) && (
          <small className="metadata-status">Teks deskripsi kolom tidak tersedia dari SAP untuk tabel ini.</small>
        )}
        <button
          className="text-button structure-button"
          onClick={() => inspectTable(source)}
          disabled={!source.table_name || !query.target || busy}
        >
          <Search size={14} /> Muat ulang struktur
        </button>
        {structureText[source.alias] && !metadataFor(source).length && (
          <div className="metadata-status">Struktur belum dapat dibaca. Coba muat ulang atau periksa akses SAP.</div>
        )}
        {index > 0 && (
          <div className="join-form">
            <span className="join-label">RELASI / JOIN</span>
            <div className="join-row">
              <select
                value={query.joins[index - 1]?.left_alias || query.sources[0].alias}
                onChange={e => updateJoin(index - 1, { left_alias: e.target.value })}
              >
                {query.sources.slice(0, index).map(s => (
                  <option key={s.alias}>{s.alias}</option>
                ))}
              </select>
              <select
                value={query.joins[index - 1]?.how || 'left'}
                onChange={e => updateJoin(index - 1, { how: e.target.value })}
              >
                <option value="left">LEFT JOIN</option>
                <option value="inner">INNER JOIN</option>
              </select>
            </div>
            {(query.joins[index - 1]?.conditions?.length
              ? query.joins[index - 1].conditions!
              : query.joins[index - 1]?.left_field && query.joins[index - 1]?.right_field
                ? [{ left_field: query.joins[index - 1].left_field, right_field: query.joins[index - 1].right_field }]
                : []
            ).map((condition, conditionIndex, conditions) => (
              <div className="join-condition" key={conditionIndex}>
                <select
                  value={condition.left_field}
                  onChange={e =>
                    setJoinConditions(
                      index - 1,
                      conditions.map((item, i) => (i === conditionIndex ? { ...item, left_field: e.target.value } : item)),
                    )
                  }
                >
                  <option value="">Field kiri</option>
                  {metadataFor(query.sources.find(item => item.alias === query.joins[index - 1].left_alias) || query.sources[0]).map(field => (
                    <option key={field.name} value={field.name}>
                      {field.name}
                      {field.description ? ` · ${field.description}` : ''}
                    </option>
                  ))}
                </select>
                <span>=</span>
                <select
                  value={condition.right_field}
                  onChange={e =>
                    setJoinConditions(
                      index - 1,
                      conditions.map((item, i) => (i === conditionIndex ? { ...item, right_field: e.target.value } : item)),
                    )
                  }
                >
                  <option value="">Field kanan</option>
                  {metadataFor(source).map(field => (
                    <option key={field.name} value={field.name}>
                      {field.name}
                      {field.description ? ` · ${field.description}` : ''}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-button"
                  title="Hapus kondisi join"
                  onClick={() => setJoinConditions(index - 1, conditions.filter((_, i) => i !== conditionIndex))}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
            <button
              className="text-button"
              onClick={() => {
                const join = query.joins[index - 1]
                const existing = join.conditions?.length
                  ? join.conditions
                  : join.left_field && join.right_field
                    ? [{ left_field: join.left_field, right_field: join.right_field }]
                    : []
                setJoinConditions(index - 1, [...existing, { left_field: '', right_field: '' }])
              }}
              disabled={(query.joins[index - 1]?.conditions?.length || 0) >= 10}
            >
              <Plus size={13} /> Tambah kondisi
            </button>
          </div>
        )}
      </div>
    ))
  }

  if (loading) return <div className="loading-screen"><div className="spinner" />Memuat Lumina…</div>
  if (!user) return <div className="login-shell">
    <div className="login-aside"><div className="brand-mark"><Layers3 size={30} /></div>
      <div><span className="eyebrow light">ENTERPRISE REPORTING PLATFORM</span>
        <h1>Data SAP.<br /><em>Lebih terang.</em></h1>
        <p>Susun, bandingkan, dan pahami laporan bisnis dalam satu ruang kerja yang aman.</p></div>
      <div className="login-aside-foot"><ShieldCheck size={17} /> Terhubung melalui MCP Gateway</div>
    </div>
    <div className="login-panel"><form onSubmit={login} className="login-card">
      <div className="brand"><div className="brand-mark small"><Layers3 size={22} /></div><span>LUMINA</span></div>
      <span className="eyebrow">SELAMAT DATANG</span><h2>Masuk ke workspace</h2>
      <p>Gunakan akun perusahaan Anda.</p>
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
        <button className={tab === 'schedules' ? 'active' : ''} onClick={openSchedules}><BarChart3 size={18} /> Jadwal & Riwayat</button>
      </nav>
      <div className="sidebar-label saved-label">LAPORAN TERSIMPAN <span>{reports.length}</span></div>
      <div className="report-list">{reports.map(r => (
        <div key={r.id} className={`report-item ${activeReport === r.id ? 'selected' : ''}`}>
          <button className="report-item-btn" onClick={() => selectReport(r)} title={r.name}>
            <Table2 size={15} /><span>{r.name}</span>
          </button>
          <div className="report-item-menu-wrap" onClick={e => e.stopPropagation()}>
            <button
              type="button"
              className={`icon-button report-menu-btn ${reportMenuOpen === r.id ? 'active' : ''}`}
              title={`Opsi untuk "${r.name}"`}
              onClick={e => handleToggleReportMenu(e, r, false)}
            >
              <MoreVertical size={15} />
            </button>
          </div>
        </div>
      ))}
      {!reports.length && <p>Belum ada laporan.</p>}</div>

      <div className="sidebar-label saved-label shared-label">LAPORAN DIBAGIKAN <span>{sharedReports.length}</span></div>
      <div className="report-list shared-report-list">
        {sharedReports.map(sr => (
          <div key={sr.id} className={`report-item shared ${activeReport === sr.id ? 'selected' : ''}`}>
            <button className="report-item-btn" onClick={() => selectReport(sr)} title={`${sr.name} (dibagikan oleh ${sr.shared_by})`}>
              <Users size={14} />
              <div className="shared-report-text">
                <span>{sr.name}</span>
                <small>oleh {sr.shared_by}</small>
              </div>
            </button>
            <span className={`permission-badge ${sr.permission}`} title={sr.permission === 'edit' ? 'Hak Akses: Edit' : 'Hak Akses: View Only'}>
              {sr.permission === 'edit' ? 'Edit' : 'View'}
            </span>
            {sr.permission === 'edit' && (
              <div className="report-item-menu-wrap" onClick={e => e.stopPropagation()}>
                <button
                  type="button"
                  className={`icon-button report-menu-btn ${reportMenuOpen === sr.id ? 'active' : ''}`}
                  title={`Opsi untuk "${sr.name}"`}
                  onClick={e => handleToggleReportMenu(e, sr, true)}
                >
                  <MoreVertical size={15} />
                </button>
              </div>
            )}
          </div>
        ))}
        {!sharedReports.length && <p className="empty-shared-text">Belum ada laporan dibagikan.</p>}
      </div>

      {reportMenu && (
        <div
          className="report-action-menu fixed"
          style={{
            top: `${reportMenu.top}px`,
            left: `${reportMenu.left}px`,
          }}
          onClick={e => e.stopPropagation()}
        >
          <button
            type="button"
            className="report-action-item"
            onClick={() => {
              const target = reportMenu.report
              setReportMenu(null)
              openRenameModal(target)
            }}
          >
            <Edit2 size={13} />
            <span>Ganti Nama</span>
          </button>
          {!reportMenu.isShared && (
            <>
              <button
                type="button"
                className="report-action-item"
                onClick={() => {
                  const target = reportMenu.report as Report
                  setReportMenu(null)
                  openShareModal(target)
                }}
              >
                <Share2 size={13} />
                <span>Bagikan</span>
              </button>
              <div className="report-action-divider" />
              <button
                type="button"
                className="report-action-item text-danger"
                onClick={() => {
                  const target = reportMenu.report
                  setReportMenu(null)
                  deleteReport(target.id, target.name)
                }}
              >
                <Trash2 size={13} />
                <span>Hapus</span>
              </button>
            </>
          )}
        </div>
      )}

      <div className="sidebar-bottom"><div className="user-avatar">{(user.username || user.email || 'U')[0].toUpperCase()}</div>
        <div className="user-info"><strong>{user.username || user.email}</strong><small>{user.roles?.[0] || 'User'}</small></div>
        <button className="icon-button" title="Keluar" onClick={confirmLogout}><LogOut size={17} /></button></div>
    </aside>

    <main className="main">
      <header className="topbar">
        <div className="breadcrumb">Workspace <span>/</span> {tab === 'builder' ? 'Query Builder' : tab === 'compare' ? 'Bandingkan Data' : 'Jadwal & Riwayat'}</div>
        <div className="top-right" style={{ position: 'relative' }}>
          <button
            type="button"
            className="user-top-btn"
            onClick={() => setUserDropdownOpen(!userDropdownOpen)}
            title="Menu Akun"
          >
            <div className="avatar-mini">{(user.username || 'U')[0].toUpperCase()}</div>
            <span style={{ fontSize: '11px', fontWeight: 600, color: '#273c57' }}>{user.username || user.email}</span>
            <ChevronDown size={14} style={{ color: '#8898aa', transform: userDropdownOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }} />
          </button>
          {userDropdownOpen && (
            <div className="user-dropdown-menu" onClick={e => e.stopPropagation()}>
              <div className="user-dropdown-header">
                <strong>{user.username || user.email}</strong>
                <small>{user.roles?.[0] || 'User'}</small>
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
                <Lock size={14} /> Ganti Password
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
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="button subtle" onClick={() => resetWorkspace(true)} title="Bersihkan canvas & mulai query baru"><Plus size={16} /> Query Baru</button>
              <div className="undo-redo-btn-group" title="Undo / Redo (Ctrl+Z / Ctrl+Y)">
                <button
                  type="button"
                  className="icon-button"
                  onClick={handleUndo}
                  disabled={builderHistoryPast.length === 0}
                  title={builderHistoryPast.length > 0 ? `Undo perubahan terakhir (Ctrl+Z) · ${builderHistoryPast.length} langkah` : 'Tidak ada perubahan untuk di-undo'}
                >
                  <RotateCcw size={15} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  onClick={handleRedo}
                  disabled={builderHistoryFuture.length === 0}
                  title={builderHistoryFuture.length > 0 ? `Redo perubahan (Ctrl+Y) · ${builderHistoryFuture.length} langkah` : 'Tidak ada perubahan untuk di-redo'}
                >
                  <RotateCw size={15} />
                </button>
              </div>
              <button
                type="button"
                className="button subtle ai-trigger-btn"
                onClick={() => openAiAssistant('builder')}
                title="Buka Asisten AI untuk menyusun tabel, join, kolom hitung, & pivot otomatis"
              >
                <Sparkles size={15} />
                <span>Asisten AI</span>
              </button>
              {query.sources.some(source => source.filters.length > 0) && (
                <button
                  className="button subtle"
                  onClick={() => setParameterModalOpen(true)}
                  title="Atur parameter filter query"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
                >
                  <SlidersHorizontal size={15} />
                  Parameter Filter
                  <span className="count-pill" style={{ marginLeft: '2px', background: '#e1ecf8', color: '#1d5cb4' }}>
                    {query.sources.reduce((acc, s) => acc + new Set(s.filters.map(f => f.field)).size, 0)}
                  </span>
                </button>
              )}
              <button className="button primary" onClick={handleRunQueryClick} disabled={busy || !query.target}><Play size={16} fill="currentColor" />{busy ? 'Memproses…' : 'Jalankan Query'}</button>
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
                    <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span>{activeSharedPermission === 'view' ? 'LAPORAN DIBAGIKAN' : activeSharedPermission === 'edit' ? 'EDIT LAPORAN BERSAMA' : 'EDIT LAPORAN'}</span>
                      {activeSharedPermission === 'view' && <span className="permission-chip view">👁️ View Only</span>}
                      {activeSharedPermission === 'edit' && <span className="permission-chip edit">✏️ Akses Edit</span>}
                    </span>
                    <button type="button" className="text-button" style={{ fontSize: '10px', padding: 0 }}
                      onClick={() => { setActiveReport(''); setReportName(''); setActiveSharedPermission('owner') }} title="Lepas dari laporan ini untuk membuat draf baru">✕ Draf baru</button>
                  </span>
                ) : 'SIMPAN LAPORAN'}
              </label>
              <div className="inline-control">
                <input placeholder="Nama laporan" value={reportName} onChange={e => setReportName(e.target.value)} />
                <button
                  className="button primary"
                  onClick={saveReport}
                  disabled={busy || activeSharedPermission === 'view'}
                  title={activeSharedPermission === 'view' ? "Laporan ini read-only. Gunakan 'Simpan Baru' untuk menduplikasi ke laporan Anda." : activeReport ? "Perbarui laporan ini (replace)" : "Simpan laporan"}
                >
                  <Save size={15} /> Simpan
                </button>
                {activeReport && (
                  <button className="button subtle" onClick={saveAsNewReport} title="Simpan sebagai laporan baru (save as)">
                    <CopyPlus size={15} /> Simpan Baru
                  </button>
                )}
              </div>
            </div></div>
          <div className={`builder-grid ${sourcesCollapsed ? 'sources-collapsed' : ''}`}>
            {!sourcesCollapsed && (
              <section className="card source-card">
                <div className="section-head">
                  <div>
                    <span className="icon-tile blue"><Database size={18} /></span>
                    <strong>Sumber Data</strong>
                  </div>
                  <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                    <button className="text-button" onClick={() => openTableCatalog()} title="Buka katalog tabel SAP">
                      <BookOpen size={14} /> Katalog
                    </button>
                    <button className="text-button" onClick={addSource}>
                      <Plus size={15} /> Tambah
                    </button>
                    <button
                      className="icon-button"
                      onClick={() => setSourcesCollapsed(true)}
                      title="Sembunyikan panel Sumber Data (Collapse)"
                    >
                      <PanelLeftClose size={16} />
                    </button>
                  </div>
                </div>
                <div className="source-forms-container">
                  {renderSourceForms()}
                </div>
              </section>
            )}
            <section className={`card canvas-card ${isCanvasFullscreen ? 'is-fullscreen' : ''}`}>
              <div className="section-head">
                <div>
                  <span className="icon-tile purple"><Settings2 size={18} /></span>
                  <strong>Visual Canvas</strong>
                  {isCanvasFullscreen && (
                    <span className="tiny-pill" style={{ marginLeft: 6, color: '#2b5ca5', background: '#eaf2ff' }}>
                      Layar Penuh
                    </span>
                  )}
                </div>
                <div className="canvas-head-actions">
                  {!isCanvasFullscreen && (
                    <span className="tiny-pill">Geser latar · Tarik header tabel · Hubungkan field</span>
                  )}
                  {isCanvasFullscreen && (
                    <>
                      <div className="undo-redo-btn-group" title="Undo / Redo (Ctrl+Z / Ctrl+Y)">
                        <button
                          type="button"
                          className="icon-button"
                          onClick={handleUndo}
                          disabled={builderHistoryPast.length === 0}
                          title={builderHistoryPast.length > 0 ? `Undo (Ctrl+Z) · ${builderHistoryPast.length} langkah` : 'Tidak ada perubahan untuk di-undo'}
                        >
                          <RotateCcw size={14} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          onClick={handleRedo}
                          disabled={builderHistoryFuture.length === 0}
                          title={builderHistoryFuture.length > 0 ? `Redo (Ctrl+Y) · ${builderHistoryFuture.length} langkah` : 'Tidak ada perubahan untuk di-redo'}
                        >
                          <RotateCw size={14} />
                        </button>
                      </div>
                      <button
                        type="button"
                        className="button subtle ai-trigger-btn"
                        style={{ height: '32px', padding: '0 10px', fontSize: '11px', gap: '5px' }}
                        onClick={() => openAiAssistant('builder')}
                        title="Buka Asisten AI untuk menyusun query & canvas otomatis"
                      >
                        <Sparkles size={14} />
                        <span>Asisten AI</span>
                      </button>
                    </>
                  )}
                  {(sourcesCollapsed || isCanvasFullscreen) && (
                    <button
                      className="button subtle"
                      style={{ height: '32px', fontSize: '11px', padding: '0 10px', gap: '6px' }}
                      onClick={() => setSourcesModalOpen(true)}
                      title="Buka Popup Pengaturan Sumber Data"
                    >
                      <Database size={14} /> Sumber Data ({query.sources.length})
                    </button>
                  )}
                  {sourcesCollapsed && !isCanvasFullscreen && (
                    <button
                      className="button subtle"
                      style={{ height: '32px', fontSize: '11px', padding: '0 10px', gap: '6px' }}
                      onClick={() => setSourcesCollapsed(false)}
                      title="Tampilkan panel Sumber Data di samping"
                    >
                      <PanelLeftOpen size={15} /> Buka Panel
                    </button>
                  )}
                  <button
                    className="button subtle"
                    style={{ height: '32px', fontSize: '11px', padding: '0 9px', gap: '5px' }}
                    onClick={() => flowRef.current?.fitView({ padding: 0.16, duration: 250 })}
                    title="Sesuaikan zoom & posisi canvas"
                  >
                    <Scan size={14} /> Reset Posisi
                  </button>
                  <button
                    className="button subtle"
                    style={{ height: '32px', fontSize: '11px', padding: '0 10px', gap: '6px' }}
                    onClick={() => setIsCanvasFullscreen(!isCanvasFullscreen)}
                    title={isCanvasFullscreen ? 'Keluar dari layar penuh (Esc)' : 'Tampilkan canvas layar penuh'}
                  >
                    {isCanvasFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                    <span>{isCanvasFullscreen ? 'Keluar Fullscreen' : 'Layar Penuh'}</span>
                  </button>
                </div>
              </div>
              <div className="flow-wrap">
                <ReactFlow<TableFlowNode>
                  nodes={flowNodes}
                  edges={flowEdges}
                  nodeTypes={nodeTypes}
                  onNodesChange={onNodesChange}
                  onConnect={connectFields}
                  onEdgeClick={(_, edge) => {
                    const match = /^join-(\d+)-(\d+)$/.exec(edge.id)
                    if (match) setRelationModal({ joinIndex: Number(match[1]), conditionIndex: Number(match[2]) })
                  }}
                  onInit={instance => { flowRef.current = instance }}
                  fitView
                  panOnDrag
                  nodesDraggable
                  nodesConnectable
                  elementsSelectable
                  deleteKeyCode={null}
                  minZoom={0.2}
                  maxZoom={1.8}
                >
                  <Background color="#dae3ef" gap={20} />
                  <Controls showInteractive={false} />
                </ReactFlow>
              </div>
              <div className="canvas-foot">
                <span className="connection-dot" /> Semua operasi SAP melalui MCP Gateway
              </div>
            </section>
          </div>
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
                <span>{source.fields.length} tampil · {new Set(source.filters.map(filter => filter.field)).size} filter</span></div>
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
                      checked={source.fields.includes(field.name)} onChange={e => {
                        const column = `${source.alias}.${field.name}`
                        setVisibleColumns(current => e.target.checked
                          ? current.includes(column) ? current : [...current, column]
                          : current.filter(name => name !== column))
                        if (activePivot && column !== activePivot.column && column !== activePivot.value) {
                          setActivePivot(current => current ? {
                            ...current,
                            rows: e.target.checked
                              ? current.rows.includes(column) ? current.rows : [...current.rows, column]
                              : current.rows.filter(name => name !== column),
                          } : current)
                          setPivotRows(current => e.target.checked
                            ? current.includes(column) ? current : [...current, column]
                            : current.filter(name => name !== column))
                        }
                        updateSource(sourceIndex, {
                          fields: e.target.checked ? [...source.fields, field.name] : source.fields.filter(name => name !== field.name),
                        })
                      }} />
                    <input type="checkbox" aria-label={`Filter ${source.table_name}.${field.name}`}
                      checked={selectedFilter} disabled={!selectedFilter && new Set(source.filters.map(filter => filter.field)).size >= 10}
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
            {query.sources.some(source => source.filters.length > 0) && (
              <div style={{
                marginTop: '16px',
                padding: '12px 16px',
                background: '#f4f8fd',
                border: '1px solid #d4e3f5',
                borderRadius: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '12px',
                flexWrap: 'wrap',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span className="icon-tile blue" style={{ width: '32px', height: '32px', borderRadius: '6px' }}>
                    <SlidersHorizontal size={16} />
                  </span>
                  <div>
                    <strong style={{ fontSize: '12px', color: '#1e3d64', display: 'block' }}>
                      {query.sources.reduce((acc, s) => acc + new Set(s.filters.map(f => f.field)).size, 0)} Parameter Filter Aktif
                    </strong>
                    <span style={{ fontSize: '11px', color: '#627c9d' }}>
                      Nilai parameter akan dimunculkan dalam popup sebelum query dijalankan.
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="button subtle"
                  style={{ background: '#fff', fontSize: '11px', height: '32px' }}
                  onClick={() => setParameterModalOpen(true)}
                >
                  <SlidersHorizontal size={14} /> Atur Nilai Parameter
                </button>
              </div>
            )}
          </section>
          <section className="card results-card" ref={queryResultRef}><div className="section-head"><div><span className="icon-tile green"><BarChart3 size={18} /></span><strong>Hasil Laporan</strong><span className="count-pill">{data.rows.length} baris</span></div>
            <div className="results-actions">
              <button className="button subtle" onClick={scrollToTop} title="Kembali ke atas"><ArrowUp size={15} /> Ke Atas</button>
              <button className="button subtle" onClick={() => setColumnChooserOpen(!columnChooserOpen)} disabled={!data.columns.length}><Columns3 size={16} /> Pilih Kolom</button>
              <button
                className="button subtle"
                onClick={() => openFormulaModal(null)}
                disabled={!baseData.rows.length}
                title="Kelola & Tambah Kolom Hitung"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                <Plus size={16} /> Kolom Hitung
                {calculatedColumns.length > 0 && (
                  <span className="count-pill" style={{ marginLeft: '2px', background: '#e1ecf8', color: '#1d5cb4' }}>
                    {calculatedColumns.length}
                  </span>
                )}
              </button>
              <button className="button subtle" onClick={() => setPivotOpen(!pivotOpen)} disabled={!data.rows.length}><Settings2 size={16} /> Pivot Data</button>
              <button className="button subtle" onClick={exportData} disabled={!data.rows.length}><Download size={16} /> Excel</button>
            </div></div>
            {data.columns.length > 0 && <div className="column-picker"><span>{visibleColumns.length} dari {data.columns.length} kolom tampil</span><button className="text-button" onClick={() => setColumnChooserOpen(true)}><Columns3 size={14} /> Atur kolom</button></div>}
            {data.rows.length ? (
              <div className="query-table-wrap">
                <table className="report-matrix">
                  <thead>
                    <tr>
                      <th className="row-idx">#</th>
                      {visibleColumns.filter(c => data.columns.includes(c)).map(c => {
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
                          {visibleColumns.filter(c => data.columns.includes(c)).map(c => {
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
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="undo-redo-btn-group" title="Undo / Redo (Ctrl+Z / Ctrl+Y)">
              <button
                type="button"
                className="icon-button"
                onClick={handleUndo}
                disabled={compareHistoryPast.length === 0}
                title={compareHistoryPast.length > 0 ? `Undo perbandingan terakhir (Ctrl+Z) · ${compareHistoryPast.length} langkah` : 'Tidak ada perubahan untuk di-undo'}
              >
                <RotateCcw size={15} />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={handleRedo}
                disabled={compareHistoryFuture.length === 0}
                title={compareHistoryFuture.length > 0 ? `Redo perbandingan (Ctrl+Y) · ${compareHistoryFuture.length} langkah` : 'Tidak ada perubahan untuk di-redo'}
              >
                <RotateCw size={15} />
              </button>
            </div>
            <button
              type="button"
              className="button subtle ai-trigger-btn"
              onClick={() => openAiAssistant('compare')}
              title="Buka Asisten AI untuk menentukan target server, tabel, dan filter perbandingan otomatis"
            >
              <Sparkles size={15} />
              <span>Asisten AI</span>
            </button>
            {compareFilters.length > 0 && (
              <button
                className="button subtle"
                onClick={() => setCompareParameterModalOpen(true)}
                title="Atur parameter filter perbandingan"
                style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
              >
                <SlidersHorizontal size={15} />
                Parameter Filter
                <span className="count-pill" style={{ marginLeft: '2px', background: '#e1ecf8', color: '#1d5cb4' }}>
                  {new Set(compareFilters.map(f => f.field)).size}
                </span>
              </button>
            )}
            <button className="button primary" onClick={handleRunCompareClick} disabled={busy || servers.length < 2}><GitCompareArrows size={16} /> Bandingkan</button>
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
          <div className="toolbar">
            <div className="field-group" style={{ minWidth: '220px' }}>
              <label>SERVER SUMBER</label>
              <select value={compareTarget} onChange={e => { setCompareTarget(e.target.value); setCompareFilters([]) }}>
                <option value="">Pilih server sumber</option>
                {servers.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div style={{ display: 'grid', placeItems: 'center', height: '40px', padding: '0 4px', color: '#5583dc' }}>
              <GitCompareArrows size={20} />
            </div>
            <div className="field-group" style={{ minWidth: '220px' }}>
              <label>SERVER PEMBANDING</label>
              <select value={otherTarget} onChange={e => setOtherTarget(e.target.value)}>
                <option value="">Pilih server pembanding</option>
                {servers.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div className="field-group" style={{ minWidth: '200px' }}>
              <label>TABEL SAP</label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  placeholder="Contoh: MARA, MCH1"
                  value={compareTable}
                  onChange={e => { setCompareTable(e.target.value.toUpperCase()); setCompareFilters([]) }}
                />
                <button
                  type="button"
                  className="button subtle"
                  style={{ height: '40px', padding: '0 10px', fontSize: '11px' }}
                  onClick={() => openTableCatalog(undefined, 'compare')}
                  disabled={!compareTarget}
                  title="Cari di katalog tabel SAP"
                >
                  <BookOpen size={14} /> Katalog
                </button>
              </div>
            </div>
            <div className="field-group narrow">
              <label>BATAS BARIS</label>
              <input
                type="number"
                min={1}
                max={1000}
                value={compareRowcount}
                onChange={e => setCompareRowcount(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="card field-selection-card" style={{ marginBottom: '18px' }}>
            <div className="section-head">
              <div>
                <span className="icon-tile blue"><Columns3 size={18} /></span>
                <strong>Kolom Tabel & Parameter Filter Perbandingan</strong>
                {compareTable && <span className="tiny-pill">{compareTable}</span>}
              </div>
              <span className="tiny-pill">Semua kolom dibandingkan · Centang untuk membuat filter</span>
            </div>
            <p className="field-selection-intro" style={{ margin: 0, padding: '14px 20px 4px' }}>
              Centang kolom yang ingin dibatasi nilainya sebelum perbandingan dijalankan. Key baris diambil otomatis dari struktur SAP kedua server.
            </p>
            <div style={{ padding: '14px 20px 20px' }}>
              <div className="field-selection-table" style={{ width: '100%', maxWidth: '100%' }}>
                <div className="field-selection-title">
                  <strong>{compareTable || 'Tabel SAP'}</strong>
                  <span>{compareMetadata.length} kolom · {compareFilters.length} filter aktif</span>
                </div>
                <input
                  placeholder="Cari kolom (nama, deskripsi, atau tipe data)…"
                  value={compareFieldSearch}
                  onChange={e => setCompareFieldSearch(e.target.value)}
                  disabled={!compareMetadata.length}
                />
                <div className="field-selection-controls">
                  <div className="field-filter-pills">
                    <button
                      type="button"
                      className={`field-filter-pill ${compareFilterMode === 'all' ? 'active' : ''}`}
                      onClick={() => setCompareFilterMode('all')}
                    >
                      Semua
                    </button>
                    <button
                      type="button"
                      className={`field-filter-pill ${compareFilterMode === 'selected' ? 'active' : ''}`}
                      onClick={() => setCompareFilterMode('selected')}
                    >
                      Dipilih ({compareFilters.length})
                    </button>
                    <button
                      type="button"
                      className={`field-filter-pill ${compareFilterMode === 'keys' ? 'active' : ''}`}
                      onClick={() => setCompareFilterMode('keys')}
                    >
                      Key
                    </button>
                  </div>
                  <select
                    className="field-sort-select"
                    value={compareSortOrder}
                    onChange={e => setCompareSortOrder(e.target.value as any)}
                    title="Urutan kolom"
                  >
                    <option value="sap">Urutan SAP</option>
                    <option value="selected_first">Dipilih Duluan</option>
                    <option value="keys_first">Key Duluan</option>
                    <option value="az">A - Z</option>
                  </select>
                </div>
                <div className="field-selection-head">
                  <span>Kolom</span>
                  <span style={{ textAlign: 'center' }}>Filter</span>
                </div>
                <div className="field-selection-list" style={{ maxHeight: '280px' }}>
                  {(() => {
                    const term = compareFieldSearch.trim().toUpperCase()
                    let fields = compareMetadata.filter(field => {
                      const desc = (field.description || '').toUpperCase()
                      return !term || field.name.includes(term) || desc.includes(term) || field.data_type.toUpperCase().includes(term)
                    })
                    if (compareFilterMode === 'selected') {
                      fields = fields.filter(f => compareFilters.some(flt => flt.field === f.name))
                    } else if (compareFilterMode === 'keys') {
                      fields = fields.filter(f => f.is_key)
                    }

                    if (compareSortOrder === 'az') {
                      fields = [...fields].sort((a, b) => a.name.localeCompare(b.name))
                    } else if (compareSortOrder === 'selected_first') {
                      fields = [...fields].sort((a, b) => {
                        const aSel = compareFilters.some(flt => flt.field === a.name) ? 0 : 1
                        const bSel = compareFilters.some(flt => flt.field === b.name) ? 0 : 1
                        if (aSel !== bSel) return aSel - bSel
                        return compareMetadata.indexOf(a) - compareMetadata.indexOf(b)
                      })
                    } else if (compareSortOrder === 'keys_first') {
                      fields = [...fields].sort((a, b) => {
                        const aKey = a.is_key ? 0 : 1
                        const bKey = b.is_key ? 0 : 1
                        if (aKey !== bKey) return aKey - bKey
                        return compareMetadata.indexOf(a) - compareMetadata.indexOf(b)
                      })
                    }

                    if (compareMetadataLoading) {
                      return <div className="catalog-loading">Memuat kolom tabel SAP…</div>
                    }
                    if (compareMetadataError) {
                      return <div className="alert error" style={{ margin: '10px' }}>{compareMetadataError}</div>
                    }
                    if (!compareTable) {
                      return <div className="empty-small">Pilih tabel SAP untuk melihat kolomnya.</div>
                    }
                    if (!fields.length) {
                      return <div className="empty-small">{compareMetadata.length ? 'Tidak ada kolom cocok.' : 'Struktur tabel belum tersedia.'}</div>
                    }

                    return fields.map(field => {
                      const selected = compareFilters.some(filter => filter.field === field.name)
                      return (
                        <div
                          className="field-selection-row"
                          key={field.name}
                          style={{ gridTemplateColumns: 'minmax(0, 1fr) 52px' }}
                        >
                          <span title={fieldTitle(field)}>
                            <FieldName field={field} showType />
                            {field.is_key && <KeyRound size={11} className="key-icon" />}
                          </span>
                          <input
                            type="checkbox"
                            aria-label={`Filter ${compareTable}.${field.name}`}
                            checked={selected}
                            disabled={!selected && compareFilters.length >= 10}
                            onChange={e => setCompareFilters(current => e.target.checked
                              ? [...current, { field: field.name, operator: 'EQ', value: '' }]
                              : current.filter(filter => filter.field !== field.name)
                            )}
                          />
                        </div>
                      )
                    })
                  })()}
                </div>
              </div>

              {compareFilters.length > 0 && (
                <div style={{
                  marginTop: '16px',
                  padding: '12px 16px',
                  background: '#f4f8fd',
                  border: '1px solid #d4e3f5',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '12px',
                  flexWrap: 'wrap',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span className="icon-tile purple" style={{ width: '32px', height: '32px', borderRadius: '6px' }}>
                      <SlidersHorizontal size={16} />
                    </span>
                    <div>
                      <strong style={{ fontSize: '12px', color: '#1e3d64', display: 'block' }}>
                        {new Set(compareFilters.map(f => f.field)).size} Parameter Filter Perbandingan Aktif
                      </strong>
                      <span style={{ fontSize: '11px', color: '#627c9d' }}>
                        Nilai parameter berlaku identik untuk server sumber dan pembanding, dan dapat diatur via popup.
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="button subtle"
                    style={{ background: '#fff', fontSize: '11px', height: '32px' }}
                    onClick={() => setCompareParameterModalOpen(true)}
                  >
                    <SlidersHorizontal size={14} /> Atur Nilai Parameter
                  </button>
                </div>
              )}
            </div>
          </div>
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

        {tab === 'schedules' && <><div className="page-heading"><div><span className="eyebrow">AUTOMATION</span><h1>Jadwal & Riwayat</h1>
          <p>Jalankan laporan tersimpan secara berkala. Unduh hasil Excel dari riwayat.</p></div></div>
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
    {sourcesModalOpen && (
      <div className="modal-backdrop" onClick={() => setSourcesModalOpen(false)}>
        <div className="modal-card sources-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <div className="modal-title">
              <span className="modal-title-icon blue"><Database size={18} /></span>
              <span>Pengaturan Sumber Data & Relasi ({query.sources.length} Tabel)</span>
            </div>
            <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
              <button
                className="button subtle"
                style={{ height: '30px', fontSize: '11px', padding: '0 9px', gap: '4px' }}
                onClick={() => openTableCatalog()}
                title="Cari katalog tabel SAP"
              >
                <BookOpen size={13} /> Katalog
              </button>
              <button
                className="button primary"
                style={{ height: '30px', fontSize: '11px', padding: '0 9px', gap: '4px' }}
                onClick={addSource}
              >
                <Plus size={13} /> Tambah Tabel
              </button>
              <button
                className="icon-button"
                title="Tutup"
                onClick={() => setSourcesModalOpen(false)}
              >
                <X size={16} />
              </button>
            </div>
          </div>
          <div className="sources-modal-body">
            {renderSourceForms()}
          </div>
          <div className="modal-actions">
            <button className="button primary" onClick={() => setSourcesModalOpen(false)}>
              Selesai
            </button>
          </div>
        </div>
      </div>
    )}
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
      <div className="modal-backdrop confirm-backdrop" onClick={() => setConfirmModal(c => ({ ...c, open: false }))}>
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
    {renameModal.open && (
      <div
        className="modal-backdrop"
        onClick={() => !renameModal.busy && setRenameModal({ open: false, reportId: '', name: '', busy: false, error: '' })}
      >
        <div className="modal-card" onClick={e => e.stopPropagation()} style={{ maxWidth: '420px' }}>
          <div className="modal-head">
            <div className="modal-title">
              <span className="modal-title-icon blue"><Edit2 size={16} /></span>
              <span>Ganti Nama Laporan</span>
            </div>
            <button
              type="button"
              className="icon-button"
              title="Tutup"
              disabled={renameModal.busy}
              onClick={() => setRenameModal({ open: false, reportId: '', name: '', busy: false, error: '' })}
            >
              <X size={16} />
            </button>
          </div>
          <form onSubmit={handleRenameSubmit}>
            <div className="modal-body" style={{ display: 'grid', gap: '14px', padding: '20px' }}>
              <p style={{ margin: 0, fontSize: '12px', color: '#64748b', lineHeight: 1.5 }}>
                Tentukan nama baru untuk laporan ini:
              </p>
              <label style={{ display: 'grid', gap: '6px' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#334863' }}>Nama Laporan</span>
                <input
                  type="text"
                  value={renameModal.name}
                  onChange={e => setRenameModal(prev => ({ ...prev, name: e.target.value, error: '' }))}
                  placeholder="Masukkan nama laporan..."
                  autoFocus
                  maxLength={160}
                  required
                  disabled={renameModal.busy}
                  style={{ width: '100%', height: '38px', fontSize: '12px' }}
                />
              </label>
              {renameModal.error && (
                <div className="alert error" style={{ margin: 0, padding: '8px 12px', fontSize: '11px' }}>
                  {renameModal.error}
                </div>
              )}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="button subtle"
                disabled={renameModal.busy}
                onClick={() => setRenameModal({ open: false, reportId: '', name: '', busy: false, error: '' })}
              >
                Batal
              </button>
              <button
                type="submit"
                className="button primary"
                disabled={renameModal.busy || !renameModal.name.trim()}
              >
                {renameModal.busy ? (
                  <>
                    <span className="spinner" />
                    <span>Menyimpan…</span>
                  </>
                ) : (
                  'Simpan Perubahan'
                )}
              </button>
            </div>
          </form>
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
              <span>{user?.mustChangePassword ? 'Wajib Ganti Password Akun' : 'Ganti Password'}</span>
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
                  Perbarui kata sandi login Anda. Kata sandi ini berlaku untuk seluruh sistem Lumina.
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
    {formulaOpen && (
      <div className="modal-backdrop" onClick={() => setFormulaOpen(false)}>
        <div className="modal-card formula-modal" onClick={e => e.stopPropagation()} style={{ width: 'min(720px, 100%)' }}>
          <div className="modal-head">
            <div className="modal-title">
              <span className="modal-title-icon blue"><Plus size={18} /></span>
              <span>{editingFormulaIndex !== null ? 'Edit Kolom Hitung' : 'Pengaturan Kolom Hitung'}</span>
            </div>
            <button className="icon-button" title="Tutup" onClick={() => setFormulaOpen(false)}>
              <X size={16} />
            </button>
          </div>
          <div className="formula-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxHeight: '78vh', overflowY: 'auto' }}>
            {calculatedColumns.length > 0 && (
              <div style={{ background: '#f8fbff', border: '1px solid #dce8f6', borderRadius: '8px', padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <span style={{ fontSize: '11px', fontWeight: 700, color: '#274b77' }}>
                    Daftar Kolom Hitung Aktif ({calculatedColumns.length})
                  </span>
                  {editingFormulaIndex !== null && (
                    <button
                      type="button"
                      className="text-button"
                      style={{ fontSize: '10px' }}
                      onClick={() => openFormulaModal(null)}
                    >
                      + Buat Kolom Baru
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {calculatedColumns.map((calc, idx) => {
                    const isEditing = editingFormulaIndex === idx
                    return (
                      <div
                        key={calc.name}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '6px 10px',
                          background: isEditing ? '#e8f2fe' : '#fff',
                          border: isEditing ? '1px solid #7cb3f3' : '1px solid #e2ecf7',
                          borderRadius: '6px',
                          fontSize: '11px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, overflow: 'hidden' }}>
                          <strong style={{ color: '#1f3c64' }}>{calc.name}</strong>
                          <span style={{ color: '#7a8fa9', fontSize: '10.5px' }}>
                            {calc.expression
                              ? `= ${calc.expression}`
                              : `[${calc.operation?.toUpperCase()}] ${(calc.fields || []).join(', ')}`}
                          </span>
                        </div>
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center', flexShrink: 0 }}>
                          <button
                            type="button"
                            className="button subtle"
                            style={{ padding: '0.2rem 0.5rem', height: '26px', fontSize: '10px', gap: '4px' }}
                            title="Edit kolom ini"
                            onClick={() => openFormulaModal(idx)}
                          >
                            <Edit2 size={12} /> Edit
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            title="Hapus kolom ini"
                            onClick={() => removeCalculatedColumn(idx)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: '4px', borderBottom: '1px solid #e2ecf7', paddingBottom: '6px' }}>
              <button
                type="button"
                className={`matrix-filter-btn ${formulaMode === 'custom' ? 'active' : ''}`}
                style={{ fontSize: '11px', padding: '6px 12px' }}
                onClick={() => setFormulaMode('custom')}
              >
                Formula Fleksibel (Multiple Operasi)
              </button>
              <button
                type="button"
                className={`matrix-filter-btn ${formulaMode === 'simple' ? 'active' : ''}`}
                style={{ fontSize: '11px', padding: '6px 12px' }}
                onClick={() => setFormulaMode('simple')}
              >
                Operasi Tunggal Sederhana
              </button>
            </div>

            <div className="designer-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
              <label>
                Nama Kolom Hasil
                <input
                  placeholder="Contoh: Total_Volume, Berat_Kotor, atau Luas_m2"
                  value={formulaName}
                  onChange={e => setFormulaName(e.target.value)}
                />
              </label>
            </div>

            {formulaMode === 'custom' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <label style={{ display: 'grid', gap: '5px', fontSize: '10px', color: '#4a6383', fontWeight: 700 }}>
                  Rumus Matematika Bebas
                  <input
                    style={{ height: '38px', fontFamily: 'monospace', fontSize: '12px', padding: '0 10px' }}
                    placeholder="Contoh: ([Panjang] * [Lebar] * [Thickness]) / 1000"
                    value={formulaExpression}
                    onChange={e => setFormulaExpression(e.target.value)}
                  />
                </label>
                <div style={{ fontSize: '10.5px', color: '#687b92', lineHeight: 1.4 }}>
                  Mendukung operasi gabungan seperti <code>+</code>, <code>-</code>, <code>*</code>, <code>/</code>, tanda kurung <code>()</code>, dan konstanta angka.
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', background: '#f9fbfe', padding: '10px 12px', borderRadius: '6px', border: '1px solid #e4edf8' }}>
                  <span style={{ fontSize: '10px', fontWeight: 700, color: '#38577e' }}>
                    Klik Kolom di Bawah Ini untuk Memasukkan ke Rumus:
                  </span>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '130px', overflowY: 'auto' }}>
                    {formulaSourceColumns.filter(column => column !== formulaName).map(col => (
                      <button
                        key={col}
                        type="button"
                        className="button subtle"
                        style={{ height: '26px', fontSize: '10.5px', padding: '0 8px', background: '#fff' }}
                        title={`Tambahkan [${col}] ke dalam rumus`}
                        onClick={() => {
                          setFormulaExpression(prev => prev ? `${prev} [${col}]` : `[${col}]`)
                        }}
                      >
                        + [{col}]
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                  <span style={{ fontSize: '10px', fontWeight: 700, color: '#38577e' }}>Simbol Cepat:</span>
                  {['+', '-', '*', '/', '(', ')', '100', '1000'].map(sym => (
                    <button
                      key={sym}
                      type="button"
                      className="button subtle"
                      style={{ height: '24px', fontSize: '11px', padding: '0 7px' }}
                      onClick={() => setFormulaExpression(prev => prev ? `${prev} ${sym}` : sym)}
                    >
                      {sym}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="text-button"
                    style={{ fontSize: '10px', marginLeft: 'auto' }}
                    onClick={() => setFormulaExpression('')}
                  >
                    Bersihkan Rumus
                  </button>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div className="designer-grid">
                  <label>
                    Operasi
                    <select value={formulaOperation} onChange={e => { setFormulaOperation(e.target.value); setFormulaFields(['']) }}>
                      <option value="sum">SUM · Jumlah</option>
                      <option value="average">AVERAGE · Rata-rata</option>
                      <option value="min">MIN · Terkecil</option>
                      <option value="max">MAX · Terbesar</option>
                      <option value="subtract">Kurang (−)</option>
                      <option value="multiply">Kali (×)</option>
                      <option value="divide">Bagi (÷)</option>
                    </select>
                  </label>
                </div>
                <div className="designer-fields">
                  <strong>Kolom sumber</strong>
                  {formulaFields.map((field, index) => (
                    <div className="designer-field-row" key={index}>
                      <select
                        value={field}
                        onChange={e => setFormulaFields(current => current.map((item, i) => i === index ? e.target.value : item))}
                      >
                        <option value="">Pilih kolom {index + 1}</option>
                        {formulaSourceColumns.filter(column => column !== formulaName).map(column => (
                          <option key={column} value={column}>
                            {column}{resultDescriptions[column] ? ` · ${resultDescriptions[column]}` : ''}
                          </option>
                        ))}
                      </select>
                      {formulaFields.length > 1 && (
                        <button
                          className="icon-button"
                          title="Hapus kolom"
                          onClick={() => setFormulaFields(current => current.filter((_, i) => i !== index))}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                  <button
                    className="text-button"
                    onClick={() => setFormulaFields(current => [...current, ''])}
                    disabled={formulaOperation === 'divide' ? formulaFields.length >= 2 : formulaFields.length >= 12}
                  >
                    <Plus size={14} /> Tambah kolom sumber
                  </button>
                </div>
              </div>
            )}
          </div>
          <div className="modal-actions">
            <button className="button subtle" onClick={() => setFormulaOpen(false)}>Batal</button>
            <button
              className="button primary"
              onClick={runFormula}
              disabled={
                !formulaName.trim() ||
                (formulaMode === 'custom'
                  ? !formulaExpression.trim()
                  : (!formulaFields.every(Boolean) || (formulaOperation === 'divide' && formulaFields.length !== 2) || (['sum', 'average', 'subtract', 'multiply'].includes(formulaOperation) && formulaFields.length < 2)))
              }
            >
              {editingFormulaIndex !== null ? 'Simpan Perubahan' : 'Buat Kolom'}
            </button>
          </div>
        </div>
      </div>
    )}

    {pivotOpen && (
      <div className="modal-backdrop" onClick={() => setPivotOpen(false)}>
        <div className="modal-card pivot-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <div className="modal-title">
              <span className="modal-title-icon blue"><Settings2 size={18} /></span>
              <span>Pengaturan Pivot</span>
              {activePivot && <span className="tiny-pill" style={{ marginLeft: '8px' }}>Pivot aktif</span>}
            </div>
            <button className="icon-button" title="Tutup" onClick={() => setPivotOpen(false)}>
              <X size={16} />
            </button>
          </div>
          <div className="pivot-modal-body">
            <small style={{ color: '#687b92', fontSize: '11px' }}>
              Seperti Excel: Baris mengelompokkan record, Kolom menjadi header baru, Nilai mengisi sel perpotongan.
            </small>
            <div className="pivot-areas">
              <div className="pivot-area">
                <strong>Baris</strong>
                <small>Satu baris untuk tiap kombinasi field</small>
                {pivotRows.map((field, index) => (
                  <div className="designer-field-row" key={index}>
                    <select
                      value={field}
                      onChange={e => setPivotRows(current => current.map((item, i) => i === index ? e.target.value : item))}
                    >
                      <option value="">Pilih field Baris</option>
                      {sourceColumns.map(column => (
                        <option key={column} value={column}>
                          {column}{resultDescriptions[column] ? ` · ${resultDescriptions[column]}` : ''}
                        </option>
                      ))}
                    </select>
                    {pivotRows.length > 1 && (
                      <button
                        className="icon-button"
                        title="Hapus field Baris"
                        onClick={() => setPivotRows(current => current.filter((_, i) => i !== index))}
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                ))}
                <button
                  className="text-button"
                  onClick={() => setPivotRows(current => [...current, ''])}
                  disabled={pivotRows.length >= Math.max(sourceColumns.length, 30)}
                >
                  <Plus size={14} /> Tambah field Baris
                </button>
              </div>

              <div className="pivot-area">
                <strong>Kolom</strong>
                <small>Contoh: nama karakteristik</small>
                <select value={pivotColumn} onChange={e => setPivotColumn(e.target.value)}>
                  <option value="">Pilih field Kolom</option>
                  {sourceColumns.map(column => (
                    <option key={column} value={column}>
                      {column}{resultDescriptions[column] ? ` · ${resultDescriptions[column]}` : ''}
                    </option>
                  ))}
                </select>
              </div>

              <div className="pivot-area">
                <strong>Nilai</strong>
                <small>Contoh: nilai karakteristik (ATWRT)</small>
                <select value={pivotValue} onChange={e => setPivotValue(e.target.value)}>
                  <option value="">Pilih field Nilai (Utama)</option>
                  {sourceColumns.map(column => (
                    <option key={column} value={column}>
                      {column}{resultDescriptions[column] ? ` · ${resultDescriptions[column]}` : ''}
                    </option>
                  ))}
                </select>
                <select value={pivotAgg} onChange={e => setPivotAgg(e.target.value)}>
                  <option value="first">Nilai pertama</option>
                  <option value="sum">SUM · Jumlah</option>
                  <option value="mean">AVERAGE · Rata-rata</option>
                  <option value="count">COUNT · Hitung</option>
                  <option value="min">MIN · Terkecil</option>
                  <option value="max">MAX · Terbesar</option>
                </select>
                <div style={{ marginTop: '6px', paddingTop: '8px', borderTop: '1px dashed #dbe5f2', display: 'grid', gap: '5px' }}>
                  <label style={{ fontSize: '10px', color: '#415774', fontWeight: 700 }}>
                    Nilai Cadangan (Fallback jika kosong):
                  </label>
                  <select value={pivotFallbackValue} onChange={e => setPivotFallbackValue(e.target.value)}>
                    <option value="">(Opsional) Tanpa nilai cadangan</option>
                    {sourceColumns.filter(column => column !== pivotValue).map(column => (
                      <option key={column} value={column}>
                        {column}{resultDescriptions[column] ? ` · ${resultDescriptions[column]}` : ''}
                      </option>
                    ))}
                  </select>
                  <small style={{ fontSize: '9.5px', color: '#7c8fa6', lineHeight: 1.35 }}>
                    Contoh: Jika Nilai Utama <code>ATWRT</code>, pilih <code>ATFLV</code> agar panjang/lebar/angka otomatis terisi.
                  </small>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
            <div>
              {activePivot && (
                <button
                  className="button subtle"
                  onClick={async () => {
                    const result = await applyPresentation(baseData, calculatedColumns, null)
                    setActivePivot(null)
                    setData(result)
                    setVisibleColumns(result.columns)
                    if (activeReport && activeSharedPermission !== 'view') {
                      const definition: ReportDefinition = {
                        ...query,
                        presentation: {
                          pivot: null,
                          calculatedColumns,
                          visibleColumns: result.columns,
                        },
                      }
                      api(`/reports/${encodeURIComponent(activeReport)}`, {
                        method: 'PUT',
                        body: JSON.stringify({ name: reportName, definition }),
                      }).catch(() => {})
                      setReports(prev => prev.map(r => r.id === activeReport ? { ...r, definition } : r))
                    }
                    setPivotOpen(false)
                    setNotice('Tampilan pivot dilepas.')
                  }}
                >
                  Lihat data asal
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="button subtle" onClick={() => setPivotOpen(false)}>Tutup</button>
              {activePivot && (
                <button
                  className="button subtle"
                  onClick={saveReport}
                  disabled={!activePivot || !reportName.trim()}
                  title="Simpan pivot bersama laporan"
                >
                  <Save size={14} /> Simpan ke laporan
                </button>
              )}
              <button
                className="button primary"
                onClick={runPivot}
                disabled={!pivotRows.every(Boolean) || !pivotColumn || !pivotValue}
              >
                Terapkan Pivot
              </button>
            </div>
          </div>
        </div>
      </div>
    )}

    {columnChooserOpen && data.columns.length > 0 && (
      <div className="modal-backdrop" onClick={() => setColumnChooserOpen(false)}>
        <div className="modal-card column-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <div className="modal-title">
              <span className="modal-title-icon blue"><Columns3 size={18} /></span>
              <span>Pilih & Susun Kolom Tabel</span>
            </div>
            <button className="icon-button" title="Tutup" onClick={() => setColumnChooserOpen(false)}>
              <X size={16} />
            </button>
          </div>
          <div className="column-modal-body">
            <div className="column-chooser-head" style={{ marginBottom: 0 }}>
              <input
                placeholder="Cari kolom…"
                value={columnChooserSearch}
                onChange={e => setColumnChooserSearch(e.target.value)}
                style={{ flex: 1, height: '34px', fontSize: '11px' }}
              />
              <div className="column-chooser-actions">
                <button
                  className="text-button"
                  onClick={() => setVisibleColumns(current => [...current.filter(c => data.columns.includes(c)), ...data.columns.filter(c => !current.includes(c))])}
                >
                  Tampilkan semua
                </button>
                <button
                  className="text-button"
                  onClick={() => setVisibleColumns(current => current.filter(c => data.columns.includes(c)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })))}
                >
                  Urut A–Z
                </button>
                <button
                  className="text-button"
                  onClick={() => setVisibleColumns(current => data.columns.filter(c => current.includes(c)))}
                >
                  Urutan awal
                </button>
              </div>
            </div>
            <p className="column-chooser-hint" style={{ margin: 0, fontSize: '11px', color: '#687b92' }}>
              Centang kolom yang ingin ditampilkan. Tarik ikon <GripVertical size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> untuk mengatur urutan kolom kiri-kanan.
            </p>
            <div className="column-chooser-list" style={{ maxHeight: '350px' }}>
              {[...visibleColumns.filter(column => data.columns.includes(column)), ...data.columns.filter(column => !visibleColumns.includes(column))]
                .filter(column => column.toLowerCase().includes(columnChooserSearch.toLowerCase()) || (resultDescriptions[column] || '').toLowerCase().includes(columnChooserSearch.toLowerCase()))
                .map(column => (
                  <div
                    className={`column-chooser-item${draggedColumn === column ? ' is-dragging' : ''}${dropColumn === column ? ' is-drop-target' : ''}`}
                    key={column}
                    title={[column, resultDescriptions[column]].filter(Boolean).join(' · ')}
                    onDragOver={event => {
                      if (draggedColumn && draggedColumn !== column && visibleColumns.includes(column)) {
                        event.preventDefault()
                        setDropColumn(column)
                      }
                    }}
                    onDragLeave={() => setDropColumn(current => current === column ? null : current)}
                    onDrop={event => {
                      event.preventDefault()
                      if (draggedColumn) moveVisibleColumn(draggedColumn, column)
                      setDraggedColumn(null)
                      setDropColumn(null)
                    }}
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={visibleColumns.includes(column)}
                        onChange={e => setVisibleColumns(current => e.target.checked ? [...current, column] : current.length > 1 ? current.filter(item => item !== column) : current)}
                      />
                      <strong>{column}</strong>
                      {resultDescriptions[column] && <small>{resultDescriptions[column]}</small>}
                    </label>
                    {visibleColumns.includes(column) && (
                      <span
                        className="column-drag-handle"
                        draggable
                        title={`Tarik untuk memindahkan ${column}`}
                        aria-label={`Tarik untuk memindahkan ${column}`}
                        onDragStart={event => {
                          event.dataTransfer.effectAllowed = 'move'
                          event.dataTransfer.setData('text/plain', column)
                          setDraggedColumn(column)
                        }}
                        onDragEnd={() => {
                          setDraggedColumn(null)
                          setDropColumn(null)
                        }}
                      >
                        <GripVertical size={15} />
                      </span>
                    )}
                  </div>
                ))}
            </div>
          </div>
          <div className="modal-actions">
            <span style={{ fontSize: '11px', color: '#687b92', alignSelf: 'center', marginRight: 'auto' }}>
              {visibleColumns.length} dari {data.columns.length} kolom tampil
            </span>
            <button className="button primary" onClick={() => {
              setColumnChooserOpen(false)
              if (activeReport && activeSharedPermission !== 'view') {
                const definition: ReportDefinition = {
                  ...query,
                  presentation: {
                    pivot: activePivot,
                    calculatedColumns,
                    visibleColumns,
                  },
                }
                api(`/reports/${encodeURIComponent(activeReport)}`, {
                  method: 'PUT',
                  body: JSON.stringify({ name: reportName, definition }),
                }).catch(() => {})
                setReports(prev => prev.map(r => r.id === activeReport ? { ...r, definition } : r))
              }
            }}>Selesai</button>
          </div>
        </div>
      </div>
    )}
    {parameterModalOpen && (
      <div className="modal-backdrop" onClick={() => setParameterModalOpen(false)}>
        <div className="modal-card parameter-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <div className="modal-title">
              <span className="modal-title-icon blue"><SlidersHorizontal size={18} /></span>
              <span>Parameter Filter Query</span>
            </div>
            <button className="icon-button" title="Tutup" disabled={busy} onClick={() => setParameterModalOpen(false)}>
              <X size={16} />
            </button>
          </div>
          <div className="parameter-modal-body">
            {busy && (
              <div className="modal-loading-banner">
                <span className="spinner" />
                <span>Sedang mengeksekusi query ke server SAP… Mohon tunggu hingga proses selesai.</span>
              </div>
            )}
            {error && (
              <div className="alert error" style={{ margin: 0, fontSize: '11px' }}>
                {error}
              </div>
            )}
            <small style={{ color: '#687b92', fontSize: '11px', display: 'block' }}>
              Tentukan nilai atau interval kriteria filter. Pilihan pada field yang sama digabung sebagai alternatif; field berbeda harus sama-sama terpenuhi.
            </small>
            {query.sources.flatMap((source, sourceIndex) => [...new Set(source.filters.map(filter => filter.field))].map(field => {
              const meta = metadataFor(source).find(item => item.name === field)
              const fieldProps = getFieldInputProps(meta, field)
              return (
                <div className="parameter-group" key={`${source.alias}-${field}`}>
                  <div className="parameter-group-head">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flexWrap: 'wrap' }}>
                      <strong>{source.table_name}.{field}</strong>
                      {fieldProps.typeLabel && (
                        <span className="field-type-pill" title={`Tipe SAP: ${fieldProps.typeLabel}`}>
                          {fieldProps.typeLabel}
                        </span>
                      )}
                    </div>
                    {meta?.description && <small>{meta.description}</small>}
                    <button className="text-button" disabled={busy} onClick={() => openSelectionDialog(sourceIndex, field)}>
                      <Columns3 size={14} /> Pilihan ganda
                    </button>
                  </div>
                  {source.filters.map((filter, filterIndex) => filter.field !== field || source.filters.slice(0, filterIndex).filter(item => item.field === field).length >= 2 ? null : (
                    <div className="parameter-condition" key={`${field}-${filterIndex}`}>
                      <select aria-label="Pilihan atau pengecualian" disabled={busy} value={filter.sign || 'I'} onChange={e => updateFilter(sourceIndex, filterIndex, { sign: e.target.value as 'I' | 'E' })}>
                        <option value="I">Pilih</option>
                        <option value="E">Kecualikan</option>
                      </select>
                      <select aria-label="Operator" disabled={busy} value={filter.operator} onChange={e => updateFilter(sourceIndex, filterIndex, { operator: e.target.value })}>
                        <option value="EQ">Sama dengan</option>
                        <option value="BT">Interval</option>
                        <option value="NE">Tidak sama</option>
                        <option value="GT">Lebih dari</option>
                        <option value="GE">≥</option>
                        <option value="LT">Kurang dari</option>
                        <option value="LE">≤</option>
                      </select>
                      {fieldProps.isDate ? (
                        <input
                          type="date"
                          aria-label="Nilai awal tanggal"
                          disabled={busy}
                          value={toIsoDate(filter.value)}
                          onChange={e => updateFilter(sourceIndex, filterIndex, { value: toDisplayDate(e.target.value) })}
                          title={filter.value ? `Tanggal: ${filter.value}` : 'Pilih tanggal'}
                        />
                      ) : (
                        <input
                          type="text"
                          inputMode={fieldProps.isNumeric ? 'numeric' : 'text'}
                          maxLength={fieldProps.maxLength}
                          aria-label="Nilai awal"
                          disabled={busy}
                          placeholder={filter.operator === 'BT' ? (fieldProps.maxLength ? `Dari (Maks. ${fieldProps.maxLength})` : 'Dari') : (fieldProps.maxLength ? `Nilai (Maks. ${fieldProps.maxLength})` : 'Nilai')}
                          value={filter.value}
                          onChange={e => {
                            let val = e.target.value
                            if (fieldProps.isPureNumber) {
                              val = val.replace(/\D/g, '')
                            } else if (fieldProps.isNumeric) {
                              val = val.replace(/[^0-9.,-]/g, '')
                            }
                            updateFilter(sourceIndex, filterIndex, { value: val })
                          }}
                        />
                      )}
                      {filter.operator === 'BT' && (
                        <>
                          <span className="parameter-range-separator">sampai</span>
                          {fieldProps.isDate ? (
                            <input
                              type="date"
                              aria-label="Nilai akhir tanggal"
                              disabled={busy}
                              value={toIsoDate(filter.high_value || '')}
                              onChange={e => updateFilter(sourceIndex, filterIndex, { high_value: toDisplayDate(e.target.value) })}
                              title={filter.high_value ? `Tanggal akhir: ${filter.high_value}` : 'Pilih tanggal akhir'}
                            />
                          ) : (
                            <input
                              type="text"
                              inputMode={fieldProps.isNumeric ? 'numeric' : 'text'}
                              maxLength={fieldProps.maxLength}
                              aria-label="Nilai akhir"
                              disabled={busy}
                              placeholder={fieldProps.maxLength ? `Sampai (Maks. ${fieldProps.maxLength})` : 'Sampai'}
                              value={filter.high_value || ''}
                              onChange={e => {
                                let val = e.target.value
                                if (fieldProps.isPureNumber) {
                                  val = val.replace(/\D/g, '')
                                } else if (fieldProps.isNumeric) {
                                  val = val.replace(/[^0-9.,-]/g, '')
                                }
                                updateFilter(sourceIndex, filterIndex, { high_value: val })
                              }}
                            />
                          )}
                        </>
                      )}
                      <button
                        className="icon-button"
                        title="Hapus pilihan"
                        disabled={busy}
                        aria-label={`Hapus pilihan ${field}`}
                        onClick={() => updateSource(sourceIndex, { filters: source.filters.filter((_, index) => index !== filterIndex) })}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  {source.filters.filter(filter => filter.field === field).length > 2 && (
                    <small className="parameter-more">
                      +{source.filters.filter(filter => filter.field === field).length - 2} pilihan lain · buka Pilihan ganda untuk melihat semuanya
                    </small>
                  )}
                </div>
              )
            }))}
          </div>
          <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
            <button className="button subtle" disabled={busy} onClick={() => setParameterModalOpen(false)}>
              Batal
            </button>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="button subtle"
                disabled={busy}
                onClick={() => setParameterModalOpen(false)}
              >
                Tutup & Simpan Nilai
              </button>
              <button
                className="button primary"
                disabled={busy || !query.target}
                onClick={async () => {
                  const ok = await runQuery()
                  if (ok) {
                    setParameterModalOpen(false)
                  }
                }}
              >
                {busy ? <span className="spinner" /> : <Play size={14} fill="currentColor" />}
                {busy ? 'Mengeksekusi Query…' : 'Jalankan Query'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    {compareParameterModalOpen && (
      <div className="modal-backdrop" onClick={() => !busy && setCompareParameterModalOpen(false)}>
        <div className="modal-card parameter-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <div className="modal-title">
              <span className="modal-title-icon purple"><SlidersHorizontal size={18} /></span>
              <span>Parameter Filter Perbandingan · {compareTable}</span>
            </div>
            <button className="icon-button" title="Tutup" disabled={busy} onClick={() => setCompareParameterModalOpen(false)}>
              <X size={16} />
            </button>
          </div>
          <div className="parameter-modal-body">
            {busy && (
              <div className="modal-loading-banner">
                <span className="spinner" />
                <span>Sedang mengambil & membandingkan data dari kedua server SAP… Mohon tunggu hingga proses selesai.</span>
              </div>
            )}
            {error && (
              <div className="alert error" style={{ margin: 0, fontSize: '11px' }}>
                {error}
              </div>
            )}
            <small style={{ color: '#687b92', fontSize: '11px', display: 'block' }}>
              Tentukan nilai atau interval kriteria filter untuk perbandingan. Filter ini berlaku secara identik untuk server sumber ({servers.find(s => s.id === compareTarget)?.label || compareTarget}) dan server pembanding ({servers.find(s => s.id === otherTarget)?.label || otherTarget}).
            </small>
            {[...new Set(compareFilters.map(filter => filter.field))].map(field => {
              const meta = compareMetadata.find(item => item.name === field)
              const fieldProps = getFieldInputProps(meta, field)
              return (
                <div className="parameter-group" key={`compare-${field}`}>
                  <div className="parameter-group-head">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flexWrap: 'wrap' }}>
                      <strong>{compareTable}.{field}</strong>
                      {fieldProps.typeLabel && (
                        <span className="field-type-pill" title={`Tipe SAP: ${fieldProps.typeLabel}`}>
                          {fieldProps.typeLabel}
                        </span>
                      )}
                    </div>
                    {meta?.description && <small>{meta.description}</small>}
                    <button className="text-button" disabled={busy} onClick={() => openSelectionDialog(null, field, 'compare', compareTable)}>
                      <Columns3 size={14} /> Pilihan ganda
                    </button>
                  </div>
                  {compareFilters.map((filter, filterIndex) => filter.field !== field || compareFilters.slice(0, filterIndex).filter(item => item.field === field).length >= 2 ? null : (
                    <div className="parameter-condition" key={`${field}-${filterIndex}`}>
                      <select
                        aria-label="Pilihan atau pengecualian"
                        disabled={busy}
                        value={filter.sign || 'I'}
                        onChange={e => setCompareFilters(current => current.map((item, i) => i === filterIndex ? { ...item, sign: e.target.value as 'I' | 'E' } : item))}
                      >
                        <option value="I">Pilih</option>
                        <option value="E">Kecualikan</option>
                      </select>
                      <select
                        aria-label="Operator"
                        disabled={busy}
                        value={filter.operator}
                        onChange={e => setCompareFilters(current => current.map((item, i) => i === filterIndex ? { ...item, operator: e.target.value } : item))}
                      >
                        <option value="EQ">Sama dengan</option>
                        <option value="BT">Interval</option>
                        <option value="NE">Tidak sama</option>
                        <option value="GT">Lebih dari</option>
                        <option value="GE">≥</option>
                        <option value="LT">Kurang dari</option>
                        <option value="LE">≤</option>
                      </select>
                      {fieldProps.isDate ? (
                        <input
                          type="date"
                          aria-label="Nilai awal tanggal"
                          disabled={busy}
                          value={toIsoDate(filter.value)}
                          onChange={e => setCompareFilters(current => current.map((item, i) => i === filterIndex ? { ...item, value: toDisplayDate(e.target.value) } : item))}
                          title={filter.value ? `Tanggal: ${filter.value}` : 'Pilih tanggal'}
                        />
                      ) : (
                        <input
                          type="text"
                          inputMode={fieldProps.isNumeric ? 'numeric' : 'text'}
                          maxLength={fieldProps.maxLength}
                          aria-label="Nilai awal"
                          disabled={busy}
                          placeholder={filter.operator === 'BT' ? (fieldProps.maxLength ? `Dari (Maks. ${fieldProps.maxLength})` : 'Dari') : (fieldProps.maxLength ? `Nilai (Maks. ${fieldProps.maxLength})` : 'Nilai')}
                          value={filter.value}
                          onChange={e => {
                            let val = e.target.value
                            if (fieldProps.isPureNumber) {
                              val = val.replace(/\D/g, '')
                            } else if (fieldProps.isNumeric) {
                              val = val.replace(/[^0-9.,-]/g, '')
                            }
                            setCompareFilters(current => current.map((item, i) => i === filterIndex ? { ...item, value: val } : item))
                          }}
                        />
                      )}
                      {filter.operator === 'BT' && (
                        <>
                          <span className="parameter-range-separator">sampai</span>
                          {fieldProps.isDate ? (
                            <input
                              type="date"
                              aria-label="Nilai akhir tanggal"
                              disabled={busy}
                              value={toIsoDate(filter.high_value || '')}
                              onChange={e => setCompareFilters(current => current.map((item, i) => i === filterIndex ? { ...item, high_value: toDisplayDate(e.target.value) } : item))}
                              title={filter.high_value ? `Tanggal akhir: ${filter.high_value}` : 'Pilih tanggal akhir'}
                            />
                          ) : (
                            <input
                              type="text"
                              inputMode={fieldProps.isNumeric ? 'numeric' : 'text'}
                              maxLength={fieldProps.maxLength}
                              aria-label="Nilai akhir"
                              disabled={busy}
                              placeholder={fieldProps.maxLength ? `Sampai (Maks. ${fieldProps.maxLength})` : 'Sampai'}
                              value={filter.high_value || ''}
                              onChange={e => {
                                let val = e.target.value
                                if (fieldProps.isPureNumber) {
                                  val = val.replace(/\D/g, '')
                                } else if (fieldProps.isNumeric) {
                                  val = val.replace(/[^0-9.,-]/g, '')
                                }
                                setCompareFilters(current => current.map((item, i) => i === filterIndex ? { ...item, high_value: val } : item))
                              }}
                            />
                          )}
                        </>
                      )}
                      <button
                        className="icon-button"
                        title="Hapus pilihan"
                        disabled={busy}
                        aria-label={`Hapus pilihan ${field}`}
                        onClick={() => setCompareFilters(current => current.filter((_, i) => i !== filterIndex))}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  {compareFilters.filter(filter => filter.field === field).length > 2 && (
                    <small className="parameter-more">
                      +{compareFilters.filter(filter => filter.field === field).length - 2} pilihan lain · buka Pilihan ganda untuk melihat semuanya
                    </small>
                  )}
                </div>
              )
            })}
            {compareFilters.length === 0 && (
              <div className="empty-small" style={{ textAlign: 'center', color: '#889cb5' }}>
                Belum ada parameter filter yang dipilih dari daftar kolom tabel.
              </div>
            )}
          </div>
          <div className="modal-actions" style={{ justifyContent: 'space-between' }}>
            <button className="button subtle" disabled={busy} onClick={() => setCompareParameterModalOpen(false)}>
              Batal
            </button>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="button subtle"
                disabled={busy}
                onClick={() => setCompareParameterModalOpen(false)}
              >
                Tutup & Simpan Nilai
              </button>
              <button
                className="button primary"
                disabled={busy || servers.length < 2 || !compareTarget || !otherTarget || !compareTable}
                onClick={async () => {
                  const ok = await runCompare()
                  if (ok) {
                    setCompareParameterModalOpen(false)
                  }
                }}
              >
                {busy ? <span className="spinner" /> : <GitCompareArrows size={14} />}
                {busy ? 'Membandingkan Data…' : 'Bandingkan Sekarang'}
              </button>
            </div>
          </div>
        </div>
      </div>
    )}
    {selectionDialog && (
      <div className="modal-backdrop selection-backdrop" onClick={() => setSelectionDialog(null)}>
        <div className="modal-card selection-modal" role="dialog" aria-modal="true" aria-label={`Pilihan ganda ${selectionDialog.field}`} onClick={event => event.stopPropagation()}>
          <div className="modal-head">
            <div className="modal-title">
              <span className="modal-title-icon blue"><Columns3 size={18} /></span>
              <span>Pilihan ganda · {selectionDialog.tableName || (selectionDialog.sourceIndex !== undefined ? query.sources[selectionDialog.sourceIndex]?.table_name : '')}.{selectionDialog.field}</span>
            </div>
            <button className="icon-button" title="Tutup" onClick={() => setSelectionDialog(null)}><X size={18} /></button>
          </div>
          <div className="selection-tabs">{([
            ['include_values', 'Nilai tunggal'], ['include_ranges', 'Interval'],
            ['exclude_values', 'Kecualikan nilai'], ['exclude_ranges', 'Kecualikan interval'],
          ] as [SelectionTab, string][]).map(([tab, label]) => <button key={tab} className={selectionDialog.tab === tab ? 'active' : ''} onClick={() => setSelectionDialog(current => current && { ...current, tab })}>{label}<span>{selectionDialog.entries[tab].split(/\r?\n/).filter(line => line.trim()).length}</span></button>)}</div>
          <div className="selection-modal-body"><p>{selectionDialog.tab.endsWith('ranges') ? 'Satu interval per baris. Pisahkan nilai awal dan akhir dengan Tab, titik koma, atau koma.' : 'Tempel nomor batch dari Excel atau ketik satu nomor per baris. Koma dan Tab juga diterima.'}</p><textarea autoFocus spellCheck={false} placeholder={selectionDialog.tab.endsWith('ranges') ? '0000000001;0000000010\n0000000020;0000000030' : '0000366399\n0000366400\n0000366401'} value={selectionDialog.entries[selectionDialog.tab]} onChange={event => setSelectionDialog(current => current && { ...current, entries: { ...current.entries, [current.tab]: event.target.value } })} /><small>Maksimal 30 pilihan per tabel. Nomor dengan nol di depan tetap sebagai teks.</small></div>
          <div className="selection-modal-actions"><button className="button subtle" onClick={() => setSelectionDialog(null)}>Batal</button><button className="button primary" onClick={saveSelectionDialog}>Terapkan pilihan</button></div>
        </div>
      </div>
    )}
    {shareModal.open && shareModal.report && (
      <div className="modal-backdrop" onClick={() => !shareModal.saving && setShareModal(prev => ({ ...prev, open: false }))}>
        <div className="modal-card share-modal" onClick={e => e.stopPropagation()}>
          <div className="modal-head">
            <div className="modal-title">
              <span className="modal-title-icon blue"><Share2 size={18} /></span>
              <span>Bagikan Laporan · {shareModal.report.name}</span>
            </div>
            <button
              className="icon-button"
              title="Tutup"
              disabled={shareModal.saving}
              onClick={() => setShareModal(prev => ({ ...prev, open: false }))}
            >
              <X size={16} />
            </button>
          </div>

          <div className="share-modal-body">
            {shareModal.error && (
              <div className="alert error" style={{ margin: 0, fontSize: '11px' }}>
                {shareModal.error}
              </div>
            )}

            {/* Form Tambah Share */}
            <div className="share-target-form">
              <span style={{ fontSize: '11px', fontWeight: 700, color: '#334d6e' }}>
                Pilih Pengguna & Hak Akses
              </span>
              <div className="share-input-row">
                <div className="share-user-picker" ref={shareDropdownRef}>
                  <div
                    className={`share-picker-control ${shareUserDropdownOpen ? 'open' : ''}`}
                    onClick={() => setShareUserDropdownOpen(!shareUserDropdownOpen)}
                  >
                    <Search size={15} className="share-picker-search-icon" />
                    <input
                      type="text"
                      className="share-picker-input"
                      placeholder="Cari atau pilih username tujuan…"
                      value={shareModal.targetUsername}
                      onChange={e => {
                        setShareModal(prev => ({ ...prev, targetUsername: e.target.value, error: '' }))
                        setShareUserDropdownOpen(true)
                      }}
                      onFocus={() => setShareUserDropdownOpen(true)}
                      disabled={shareModal.saving}
                    />
                    {shareModal.targetUsername && (
                      <button
                        type="button"
                        className="share-picker-clear"
                        onClick={e => {
                          e.stopPropagation()
                          setShareModal(prev => ({ ...prev, targetUsername: '', error: '' }))
                        }}
                        title="Hapus pilihan"
                      >
                        <X size={13} />
                      </button>
                    )}
                    <span className="share-picker-chevron">
                      {shareUserDropdownOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    </span>
                  </div>

                  {shareUserDropdownOpen && (
                    <div className="share-dropdown-menu">
                      <div className="share-dropdown-list">
                        {availableUsers
                          .filter(u => {
                            const term = shareModal.targetUsername.trim().toLowerCase()
                            if (!term) return true
                            return (
                              u.username.toLowerCase().includes(term) ||
                              (u.name && u.name.toLowerCase().includes(term)) ||
                              (u.role && u.role.toLowerCase().includes(term))
                            )
                          })
                          .map(u => {
                            const isSelected = shareModal.targetUsername === u.username
                            return (
                              <div
                                key={u.username}
                                className={`share-dropdown-item ${isSelected ? 'selected' : ''}`}
                                onClick={() => {
                                  setShareModal(prev => ({ ...prev, targetUsername: u.username, error: '' }))
                                  setShareUserDropdownOpen(false)
                                }}
                              >
                                <div className="share-item-avatar">
                                  {(u.username || 'U')[0].toUpperCase()}
                                </div>
                                <div className="share-item-content">
                                  <div className="share-item-top">
                                    <strong className="share-item-username">{u.username}</strong>
                                    {u.role && <span className="share-item-role">{u.role}</span>}
                                  </div>
                                  {u.name && <span className="share-item-name">{u.name}</span>}
                                </div>
                                {isSelected && <CheckCircle2 size={15} className="share-item-check" />}
                              </div>
                            )
                          })}
                        {availableUsers.filter(u => {
                          const term = shareModal.targetUsername.trim().toLowerCase()
                          if (!term) return true
                          return (
                            u.username.toLowerCase().includes(term) ||
                            (u.name && u.name.toLowerCase().includes(term)) ||
                            (u.role && u.role.toLowerCase().includes(term))
                          )
                        }).length === 0 && (
                          <div className="share-dropdown-empty">
                            <span>Tidak ditemukan pengguna yang cocok.</span>
                            {shareModal.targetUsername && (
                              <button
                                type="button"
                                className="text-button"
                                style={{ marginTop: '4px', fontSize: '11px' }}
                                onClick={() => setShareUserDropdownOpen(false)}
                              >
                                Gunakan &quot;{shareModal.targetUsername}&quot;
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <button
                  className="button primary"
                  disabled={shareModal.saving || !shareModal.targetUsername.trim()}
                  onClick={() => {
                    setShareUserDropdownOpen(false)
                    handleAddShare()
                  }}
                  style={{ height: '40px', padding: '0 16px', gap: '6px' }}
                >
                  {shareModal.saving ? <span className="spinner" /> : <UserPlus size={15} />}
                  <span>Bagikan</span>
                </button>
              </div>

              <div className="share-permission-selector">
                <div
                  className={`share-permission-card ${shareModal.permission === 'view' ? 'active' : ''}`}
                  onClick={() => !shareModal.saving && setShareModal(prev => ({ ...prev, permission: 'view' }))}
                >
                  <div className="share-perm-radio-circle">
                    {shareModal.permission === 'view' && <div className="share-perm-radio-dot" />}
                  </div>
                  <div className="share-perm-icon blue">
                    <Eye size={16} />
                  </div>
                  <div className="share-perm-text">
                    <div className="share-perm-title">Lihat Saja (View)</div>
                    <div className="share-perm-desc">Pengguna hanya dapat melihat dan mengeksekusi data laporan</div>
                  </div>
                </div>

                <div
                  className={`share-permission-card ${shareModal.permission === 'edit' ? 'active' : ''}`}
                  onClick={() => !shareModal.saving && setShareModal(prev => ({ ...prev, permission: 'edit' }))}
                >
                  <div className="share-perm-radio-circle">
                    {shareModal.permission === 'edit' && <div className="share-perm-radio-dot" />}
                  </div>
                  <div className="share-perm-icon green">
                    <Edit2 size={16} />
                  </div>
                  <div className="share-perm-text">
                    <div className="share-perm-title">Dapat Edit (Edit)</div>
                    <div className="share-perm-desc">Pengguna dapat mengubah konfigurasi query & menyimpan laporan</div>
                  </div>
                </div>
              </div>
            </div>

            {/* Daftar Pengguna yang Sudah Diberi Akses */}
            <div className="share-active-list">
              <div className="share-active-header">
                Pengguna yang Memiliki Akses ({shareModal.shares.length})
              </div>
              {shareModal.loading ? (
                <div style={{ textAlign: 'center', padding: '16px', color: '#889cb5', fontSize: '12px' }}>
                  <span className="spinner" style={{ display: 'inline-block', marginRight: '6px' }} /> Memuat daftar akses…
                </div>
              ) : shareModal.shares.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '16px', color: '#90a4bc', fontSize: '12px', background: '#f8fafc', borderRadius: '8px', border: '1px dashed #e2e8f0' }}>
                  Belum ada pengguna lain yang memiliki akses ke laporan ini.
                </div>
              ) : (
                shareModal.shares.map(s => (
                  <div key={s.id} className="share-user-row">
                    <div className="share-user-meta">
                      <div className="share-user-avatar">
                        {(s.shared_with_username || 'U')[0].toUpperCase()}
                      </div>
                      <div className="share-user-name">
                        {s.shared_with_username}
                      </div>
                    </div>
                    <div className="share-user-actions">
                      <select
                        className="share-permission-select"
                        value={s.permission}
                        disabled={shareModal.saving}
                        onChange={e => handleUpdateSharePermission(s, e.target.value as 'view' | 'edit')}
                        aria-label={`Hak akses untuk ${s.shared_with_username}`}
                      >
                        <option value="view">View (Lihat)</option>
                        <option value="edit">Edit (Ubah)</option>
                      </select>
                      <button
                        className="icon-button delete-report-btn"
                        title={`Cabut akses ${s.shared_with_username}`}
                        disabled={shareModal.saving}
                        onClick={() => handleRemoveShare(s.id, s.shared_with_username)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="modal-actions">
            <button
              className="button primary"
              onClick={() => setShareModal(prev => ({ ...prev, open: false }))}
            >
              Selesai
            </button>
          </div>
        </div>
      </div>
    )}
    {aiModalOpen && (
      <div className="modal-backdrop ai-modal-backdrop" onClick={() => setAiModalOpen(false)}>
        <div className="modal-card ai-modal" onClick={e => e.stopPropagation()}>
          <div className="ai-modal-header">
            <div className="ai-modal-title-wrap">
              <span className="ai-title-icon"><Sparkles size={20} /></span>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="ai-modal-title">Asisten AI Lumina</span>
                  <span className="ai-context-badge">
                    {aiContextMode === 'builder' ? 'Query Builder & Pipeline' : 'Bandingkan Data'}
                  </span>
                </div>
                <p className="ai-modal-subtitle">
                  {aiContextMode === 'builder'
                    ? 'Rancang tabel SAP, relasi (join), filter, rumus hitung, dan pivot otomatis.'
                    : 'Tentukan server target SAP, tabel pembanding, dan filter perbandingan otomatis.'}
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div className="ai-provider-status-group">
                <div
                  className={`ai-provider-pill ${aiProviderStatus?.primary?.online ? 'online' : aiProviderStatus?.primary?.configured ? 'configured' : 'offline'}`}
                  title={`Primary: 9Router (${aiProviderStatus?.primary?.model || 'ABAP-Git'}) - ${aiProviderStatus?.primary?.online ? 'Online' : 'Offline / Standby'}`}
                >
                  <span className="status-indicator-dot" />
                  <span>9Router (Primary)</span>
                </div>
                <div
                  className={`ai-provider-pill ${aiProviderStatus?.fallback?.online ? 'online' : aiProviderStatus?.fallback?.configured ? 'configured' : 'offline'}`}
                  title={`Fallback: OpenRouter (${aiProviderStatus?.fallback?.model || 'openrouter/auto'}) - ${aiProviderStatus?.fallback?.online ? 'Online' : aiProviderStatus?.fallback?.configured ? 'Siap' : 'Belum Dikonfigurasi'}`}
                >
                  <span className="status-indicator-dot cloud" />
                  <span>OpenRouter (Cloud)</span>
                </div>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => setAiModalOpen(false)}
                title="Tutup (Esc)"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          <div className="ai-modal-body">
            <div className="ai-mode-tabs">
              <button
                type="button"
                className={`ai-mode-tab ${aiContextMode === 'builder' ? 'active' : ''}`}
                onClick={() => { setAiContextMode('builder'); setAiResult(null); setAiError('') }}
              >
                <Table2 size={14} /> Mode Query Builder (Tabel, Join, Rumus, Pivot)
              </button>
              <button
                type="button"
                className={`ai-mode-tab ${aiContextMode === 'compare' ? 'active' : ''}`}
                onClick={() => { setAiContextMode('compare'); setAiResult(null); setAiError('') }}
              >
                <GitCompareArrows size={14} /> Mode Bandingkan Data (2 Server SAP)
              </button>
            </div>

            <div className="ai-prompt-suggestions-wrap">
              <span className="ai-suggestions-label">Contoh Instruksi Cepat:</span>
              <div className="ai-quick-prompts">
                {aiContextMode === 'builder' ? (
                  <>
                    <button
                      type="button"
                      className="ai-prompt-chip"
                      onClick={() => setAiPrompt('Tampilkan penjualan dari tabel VBAK dan VBAP tahun 2025 dengan relasi VBELN, filter mata uang WAERK EQ "IDR", tambahkan kolom hitung TOTAL_GROSS = ([T2.KWMENG] * [T2.NETPR]) * 1.11, dan buat pivot nilai per bulan ERDAT')}
                    >
                      📈 Sales Order (VBAK + VBAP) & Pivot Nilai
                    </button>
                    <button
                      type="button"
                      className="ai-prompt-chip"
                      onClick={() => setAiPrompt('Daftar material dari MARA join dengan data plant MARC berdasarkan MATNR, pilih kolom MATNR, MAKTX, WERKS, EKGRP, filter MTART EQ "FERT"')}
                    >
                      📦 Master Material (MARA + MARC)
                    </button>
                    <button
                      type="button"
                      className="ai-prompt-chip"
                      onClick={() => setAiPrompt('Analisis Purchase Order dari EKKO dan EKPO, hubungkan EBELN, hitung nilai NETWR_TOTAL = [T2.MENGE] * [T2.NETPR], dan kelompokkan pivot per Vendor LIFNR')}
                    >
                      🛒 Purchase Order (EKKO + EKPO)
                    </button>
                    <button
                      type="button"
                      className="ai-prompt-chip"
                      onClick={() => setAiPrompt('Tabel karakteristik batch AUSP join CABN berdasarkan ATINN, filter objek batch dan buat pivot karakteristik ATWRT')}
                    >
                      🔬 Karakteristik Batch (AUSP + CABN)
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="ai-prompt-chip"
                      onClick={() => setAiPrompt('Bandingkan data master material pada tabel MARA antara server DEV dan PRD untuk 200 baris pertama')}
                    >
                      🔍 Bandingkan Tabel MARA
                    </button>
                    <button
                      type="button"
                      className="ai-prompt-chip"
                      onClick={() => setAiPrompt('Bandingkan tabel Sales Order VBAK antara dua server dengan filter tahun ERDAT EQ 2025')}
                    >
                      📑 Bandingkan Dokumen Sales VBAK
                    </button>
                    <button
                      type="button"
                      className="ai-prompt-chip"
                      onClick={() => setAiPrompt('Bandingkan master vendor LFA1 antara dua server dengan filter LAND1 EQ "ID"')}
                    >
                      🏢 Bandingkan Vendor LFA1
                    </button>
                  </>
                )}
              </div>
            </div>

            <div className="ai-input-container">
              <textarea
                className="ai-textarea"
                value={aiPrompt}
                onChange={e => setAiPrompt(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    runAiAssistant()
                  }
                }}
                placeholder={aiContextMode === 'builder'
                  ? 'Tuliskan kebutuhan laporan SAP Anda di sini (misal: "Buatkan analisis penjualan VBAK dan VBAP tahun 2025, hitung subtotal kotor dengan pajak 11%, lalu pivot berdasarkan customer dan tanggal")...'
                  : 'Tuliskan perbandingan yang diinginkan (misal: "Bandingkan tabel MARA antara server DEV dan PRD dengan limit 150 baris")...'
                }
                rows={3}
              />
              <div className="ai-input-footer">
                <span className="ai-shortcut-hint">
                  Tekan <kbd>Ctrl</kbd> + <kbd>Enter</kbd> untuk memproses cepat
                </span>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {aiPrompt && (
                    <button
                      type="button"
                      className="button subtle"
                      style={{ height: '32px', fontSize: '11px', padding: '0 10px' }}
                      onClick={() => { setAiPrompt(''); setAiResult(null); setAiError('') }}
                      disabled={aiLoading}
                    >
                      Bersihkan
                    </button>
                  )}
                  <button
                    type="button"
                    className="button primary"
                    onClick={runAiAssistant}
                    disabled={aiLoading || !aiPrompt.trim()}
                  >
                    {aiLoading ? (
                      <>
                        <span className="spinner" style={{ width: '14px', height: '14px' }} />
                        <span>Memproses ({aiProgress}%)…</span>
                      </>
                    ) : (
                      <>
                        <Sparkles size={14} />
                        <span>Rancang dengan AI</span>
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {aiError && (
              <div className="alert error" style={{ margin: '8px 0', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <AlertTriangle size={16} />
                <span>{aiError}</span>
              </div>
            )}

            {aiLoading && (
              <div className="ai-loading-card">
                <div className="ai-loading-header">
                  <div className="ai-loading-title-row">
                    <span className="spinner" style={{ width: '16px', height: '16px', borderColor: '#2563eb', borderTopColor: 'transparent', flex: 'none' }} />
                    <strong style={{ fontSize: '13px', color: '#0f172a' }}>
                      {aiProgressStage || 'Asisten AI sedang menyusun rancangan…'}
                    </strong>
                  </div>
                  <span className="ai-progress-badge">
                    {aiProgress}%
                  </span>
                </div>

                <div className="ai-progress-track">
                  <div
                    className="ai-progress-bar"
                    style={{ width: `${aiProgress}%` }}
                  />
                </div>

                <div className="ai-loading-footer">
                  <span className="ai-loading-hint">
                    Penyedia: <strong>{aiProviderStatus?.primary?.online ? '9Router Local Proxy' : 'OpenRouter Cloud'}</strong>
                  </span>
                  <span className="ai-loading-hint">
                    {aiContextMode === 'builder' ? 'Menyusun tabel, relasi join, filter, kalkulasi, & pivot' : 'Menyusun server pembanding & filter perbandingan'}
                  </span>
                </div>
              </div>
            )}

            {aiResult && !aiLoading && (
              <div className="ai-result-preview">
                <div className="ai-result-meta-bar">
                  <span className="ai-provider-used-badge">
                    <Sparkles size={13} /> Dihasilkan oleh: <strong>{aiResult.provider}</strong>
                  </span>
                  <span className="ai-ready-badge">
                    <CheckCircle2 size={13} /> Rancangan Siap Diterapkan ke Workspace
                  </span>
                </div>

                {aiResult.explanation && (
                  <div className="ai-explanation-box">
                    <div style={{ fontWeight: 700, fontSize: '11px', marginBottom: '3px', color: '#1e3a8a', display: 'flex', alignItems: 'center', gap: '5px' }}>
                      <BookOpen size={13} /> Penjelasan Rancangan AI:
                    </div>
                    <div style={{ whiteSpace: 'pre-line' }}>{aiResult.explanation}</div>
                  </div>
                )}

                {aiContextMode === 'builder' && (
                  <div className="ai-components-grid">
                    <div className="ai-component-card">
                      <div className="ai-component-card-title">
                        <Database size={14} style={{ color: '#2563eb' }} />
                        <span>Tabel Sumber ({aiResult.data.sources?.length || 0})</span>
                      </div>
                      <div className="ai-component-card-body">
                        {aiResult.data.sources?.map((s, i) => (
                          <div key={i} className="ai-preview-item">
                            <span className="ai-tag">{s.alias}</span>
                            <strong>{s.table_name}</strong>
                            <span className="ai-meta-text">
                              ({s.fields?.length || 0} kolom{s.filters?.length ? `, ${s.filters.length} filter` : ''})
                            </span>
                          </div>
                        )) || <span style={{ color: '#94a3b8' }}>Tidak ada tabel</span>}
                      </div>
                    </div>

                    <div className="ai-component-card">
                      <div className="ai-component-card-title">
                        <Layers3 size={14} style={{ color: '#7c3aed' }} />
                        <span>Relasi / Join ({aiResult.data.joins?.length || 0})</span>
                      </div>
                      <div className="ai-component-card-body">
                        {aiResult.data.joins?.length ? aiResult.data.joins.map((j, i) => (
                          <div key={i} className="ai-preview-item">
                            <span className="ai-tag">{j.left_alias}</span>
                            <span>⟷</span>
                            <span className="ai-tag">{j.right_alias}</span>
                            <small style={{ color: '#64748b' }}>({j.how || 'left'})</small>
                          </div>
                        )) : <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>Tunggal / Tanpa relasi</span>}
                      </div>
                    </div>

                    <div className="ai-component-card">
                      <div className="ai-component-card-title">
                        <Columns3 size={14} style={{ color: '#0891b2' }} />
                        <span>Kolom Hitung ({aiResult.data.calculatedColumns?.length || 0})</span>
                      </div>
                      <div className="ai-component-card-body">
                        {aiResult.data.calculatedColumns?.length ? aiResult.data.calculatedColumns.map((c, i) => (
                          <div key={i} className="ai-preview-item-calc">
                            <strong>{c.name}</strong>
                            <code>{c.expression || (c.fields ? `${c.operation}(${c.fields.join(', ')})` : '')}</code>
                          </div>
                        )) : <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>Tidak ada kolom hitung</span>}
                      </div>
                    </div>

                    <div className="ai-component-card">
                      <div className="ai-component-card-title">
                        <BarChart3 size={14} style={{ color: '#ea580c' }} />
                        <span>Pivot Table</span>
                      </div>
                      <div className="ai-component-card-body">
                        {aiResult.data.pivot ? (
                          <div className="ai-pivot-summary">
                            <div><small>Baris:</small> {Array.isArray(aiResult.data.pivot.rows) ? aiResult.data.pivot.rows.join(', ') : aiResult.data.pivot.rows}</div>
                            <div><small>Kolom:</small> {aiResult.data.pivot.column}</div>
                            <div><small>Nilai:</small> {aiResult.data.pivot.value} ({aiResult.data.pivot.aggregation || 'first'})</div>
                          </div>
                        ) : (
                          <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>Tidak ada pivot (Tabel Standar)</span>
                        )}
                      </div>
                    </div>

                    {aiResult.data.visibleColumns && aiResult.data.visibleColumns.length > 0 && (
                      <div className="ai-component-card" style={{ gridColumn: '1 / -1' }}>
                        <div className="ai-component-card-title">
                          <SlidersHorizontal size={14} style={{ color: '#059669' }} />
                          <span>Urutan & Tampilan Kolom ALV ({aiResult.data.visibleColumns.length} Kolom)</span>
                          {aiResult.data.sort && (
                            <span className="ai-tag" style={{ marginLeft: 'auto', background: '#ecfdf5', color: '#047857' }}>
                              Urut Baris: {aiResult.data.sort.column} ({aiResult.data.sort.direction?.toUpperCase()})
                            </span>
                          )}
                        </div>
                        <div className="ai-component-card-body">
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '130px', overflowY: 'auto', padding: '4px 0' }}>
                            {aiResult.data.visibleColumns.map((col, idx) => (
                              <span key={idx} style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '4px',
                                background: idx === 0 ? '#eff6ff' : '#f8fafc',
                                border: idx === 0 ? '1px solid #93c5fd' : '1px solid #e2e8f0',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                fontSize: '11px',
                                color: idx === 0 ? '#1d4ed8' : '#334155',
                                fontWeight: idx === 0 ? 700 : 500,
                              }}>
                                <small style={{ color: idx === 0 ? '#3b82f6' : '#94a3b8', fontSize: '9.5px' }}>#{idx + 1}</small>
                                <span>{col}</span>
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {aiContextMode === 'compare' && (
                  <div className="ai-components-grid">
                    <div className="ai-component-card">
                      <div className="ai-component-card-title">
                        <Database size={14} style={{ color: '#2563eb' }} />
                        <span>Tabel Perbandingan</span>
                      </div>
                      <div className="ai-component-card-body">
                        <strong>{aiResult.data.table_name || '-'}</strong>
                      </div>
                    </div>
                    <div className="ai-component-card">
                      <div className="ai-component-card-title">
                        <GitCompareArrows size={14} style={{ color: '#7c3aed' }} />
                        <span>Server SAP</span>
                      </div>
                      <div className="ai-component-card-body">
                        <div><small>Sumber 1:</small> <strong>{aiResult.data.target || '-'}</strong></div>
                        <div><small>Sumber 2:</small> <strong>{aiResult.data.other_target || '-'}</strong></div>
                      </div>
                    </div>
                    <div className="ai-component-card">
                      <div className="ai-component-card-title">
                        <Filter size={14} style={{ color: '#0891b2' }} />
                        <span>Filter ({aiResult.data.filters?.length || 0})</span>
                      </div>
                      <div className="ai-component-card-body">
                        {aiResult.data.filters?.length ? aiResult.data.filters.map((f, i) => (
                          <div key={i} className="ai-preview-item">
                            <strong>{f.field}</strong> {f.operator} "{f.value}"
                          </div>
                        )) : <span style={{ color: '#94a3b8', fontStyle: 'italic' }}>Tanpa filter</span>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="modal-actions ai-modal-actions">
            <button
              type="button"
              className="button subtle"
              onClick={() => setAiModalOpen(false)}
            >
              Tutup
            </button>
            {aiResult && (
              <button
                type="button"
                className="button primary ai-apply-button"
                onClick={() => applyAiResult()}
              >
                <CheckCircle2 size={16} />
                <span>Terapkan ke Workspace</span>
              </button>
            )}
          </div>
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
