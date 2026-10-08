export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `Permintaan gagal (HTTP ${res.status})`)
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
  filters: { field: string; operator: string; value: string }[] }
export type JoinCondition = { left_field: string; right_field: string }
export type Join = { left_alias: string; left_field: string; right_alias: string; right_field: string;
  how: string; conditions?: JoinCondition[]; manual?: boolean }
export type Query = { target: string; sources: Source[]; joins: Join[]; rowcount: number }
export type GridData = { columns: string[]; rows: Row[]; warnings?: string[] }
