export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    let detail = body.detail || `Permintaan gagal (HTTP ${res.status})`
    if (typeof detail === 'object' && detail !== null) {
      if (Array.isArray(detail)) {
        detail = detail.map((d: any) => d.msg || JSON.stringify(d)).join(', ')
      } else {
        detail = detail.msg || JSON.stringify(detail)
      }
    }
    if (res.status === 401 && path !== '/auth/login' && path !== '/auth/me') {
      // Verifikasi ke /auth/me sebelum logout otomatis agar error parsial tidak mereset workspace
      fetch('/api/auth/me', { credentials: 'include' })
        .then(checkRes => {
          if (checkRes.status === 401) {
            window.dispatchEvent(new CustomEvent('lumina:unauthorized', { detail: String(detail) }))
          }
        })
        .catch(() => {})
    }
    throw new Error(String(detail))
  }
  return res.json() as Promise<T>
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

export type Row = Record<string, string | number | boolean | null>
export type Server = {
  id: string
  label: string
  resource_key: string
  sid?: string
  aliases?: string[]
  environment?: string
  is_production?: boolean
}
export type Source = { alias: string; table_name: string; fields: string[];
  filters: { field: string; operator: string; value: string; high_value?: string; sign?: 'I' | 'E' }[] }
export type JoinCondition = { left_field: string; right_field: string }
export type Join = { left_alias: string; left_field: string; right_alias: string; right_field: string;
  how: string; conditions?: JoinCondition[]; manual?: boolean }
export type Query = { target: string; sources: Source[]; joins: Join[]; rowcount: number }
export type GridData = { columns: string[]; rows: Row[]; warnings?: string[] }

type QueryJobStatus = {
  status: 'running' | 'success' | 'error' | 'cancelled'
  progress: number
  message: string
  result?: GridData
  error?: string
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError'
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Query dibatalkan.', 'AbortError'))
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(new DOMException('Query dibatalkan.', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Query besar dijalankan sebagai job di server lalu dipolling, sehingga tidak
// ada satu request HTTP panjang yang bisa terputus oleh timeout browser/proxy.
export async function runQueryJob(
  body: unknown,
  onProgress?: (progress: number, message: string) => void,
  signal?: AbortSignal,
  pollMs = 1500,
): Promise<GridData> {
  const { job_id } = await post<{ job_id: string }>('/sap/query/jobs', body)
  const jobPath = `/sap/query/jobs/${encodeURIComponent(job_id)}`
  // Tab ditutup/di-reload: hentikan job agar SAP tidak terus dibaca tanpa penerima.
  const cancelOnLeave = () => {
    fetch('/api' + jobPath, { method: 'DELETE', credentials: 'include', keepalive: true }).catch(() => {})
  }
  window.addEventListener('pagehide', cancelOnLeave)
  try {
    let transientFailures = 0
    for (;;) {
      await abortableDelay(pollMs, signal)
      let job: QueryJobStatus
      try {
        job = await api<QueryJobStatus>(jobPath, { signal })
        transientFailures = 0
      } catch (e) {
        if (isAbortError(e)) throw e
        // Gangguan jaringan sesaat tidak boleh menggagalkan query yang masih berjalan.
        if (++transientFailures <= 5 && e instanceof TypeError) continue
        throw e
      }
      if (job.status === 'success' && job.result) return job.result
      if (job.status !== 'running') throw new Error(job.error || 'Query gagal dijalankan.')
      onProgress?.(job.progress, job.message)
    }
  } catch (e) {
    if (isAbortError(e)) await api(jobPath, { method: 'DELETE' }).catch(() => {})
    throw e
  } finally {
    window.removeEventListener('pagehide', cancelOnLeave)
  }
}
