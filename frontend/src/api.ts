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
