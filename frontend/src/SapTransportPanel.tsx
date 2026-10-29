import { useEffect, useState } from 'react'
import { Settings2, X } from 'lucide-react'
import { api, post } from './api'
import type { Server } from './api'

type Config = { enable_pyrfc: boolean; enable_oidc_gateway: boolean; transport_priority: 'gateway' | 'pyrfc'; enable_transport_fallback: boolean }
type Status = { config: Config; status?: string; identity_notice?: string }

export function SapTransportPanel() {
  const [allowed, setAllowed] = useState(false)
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<Config | null>(null)
  const [servers, setServers] = useState<Server[]>([])
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    api<Status>('/admin/sap-transport').then(r => { setConfig(r.config); setAllowed(true) }).catch(() => setAllowed(false))
  }, [])
  async function show() {
    setOpen(true); setMessage(''); setBusy(true)
    try {
      const r = await api<Status>('/admin/sap-transport'); setConfig(r.config)
      const s = await api<{ resources: Server[] }>('/sap/servers'); setServers(s.resources); setTarget(s.resources[0]?.id || '')
    } catch (e) { setFailed(true); setMessage(String(e)) }
    finally { setBusy(false) }
  }
  async function save() {
    setBusy(true); setMessage('')
    try {
      const r = await api<Status>('/admin/sap-transport', { method: 'PUT', body: JSON.stringify(config) })
      setConfig(r.config); setFailed(false); setMessage('Pengaturan jembatan SAP tersimpan dan diaudit.')
    } catch (e) { setFailed(true); setMessage(String(e)) }
    finally { setBusy(false) }
  }
  async function test(route: 'gateway' | 'pyrfc') {
    setBusy(true); setMessage('')
    try {
      const r = await post<{ ok: boolean; message?: string; elapsed_ms?: number }>('/admin/sap-transport/test', { route, target })
      setFailed(!r.ok); setMessage(r.ok ? `${route}: koneksi berhasil (${r.elapsed_ms} ms).` : r.message || 'Uji koneksi gagal.')
    } catch (e) { setFailed(true); setMessage(String(e)) }
    finally { setBusy(false) }
  }
  if (!allowed || !config) return null
  return <>
    <button onClick={show}><Settings2 size={18} /> Jembatan SAP</button>
    {open && <div className="modal-backdrop" onClick={() => !busy && setOpen(false)}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="sap-transport-title" onClick={e => e.stopPropagation()} style={{ width: 'min(92vw, 620px)', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="modal-header"><h2 id="sap-transport-title"><Settings2 size={20} /> Jembatan SAP</h2><button className="icon-button" aria-label="Tutup pengaturan SAP" disabled={busy} onClick={() => setOpen(false)}><X size={20} /></button></div>
        <div style={{ padding: 24, display: 'grid', gap: 16 }}>
          <p>Gateway memakai kredensial SAP pribadi pengguna. Direct pyRFC memakai akun teknis backend per target, termasuk untuk jadwal. Gateway tidak pernah beralih ke akun teknis.</p>
          {!config.enable_pyrfc && !config.enable_oidc_gateway && <div className="alert error" role="alert">Semua akses SAP diblokir. Login OIDC dan laporan tersimpan tetap tersedia.</div>}
          <label><input type="checkbox" checked={config.enable_oidc_gateway} disabled={busy} onChange={e => setConfig({ ...config, enable_oidc_gateway: e.target.checked })} /> Aktifkan OIDC Gateway</label>
          <label><input type="checkbox" checked={config.enable_pyrfc} disabled={busy} onChange={e => setConfig({ ...config, enable_pyrfc: e.target.checked })} /> Aktifkan Direct pyRFC (akun teknis)</label>
          <label>Prioritas jalur<select value={config.transport_priority} disabled={busy} onChange={e => setConfig({ ...config, transport_priority: e.target.value as Config['transport_priority'] })}><option value="gateway">OIDC Gateway</option><option value="pyrfc">Direct pyRFC</option></select></label>
          <label><input type="checkbox" checked={config.enable_transport_fallback} disabled={busy} onChange={e => setConfig({ ...config, enable_transport_fallback: e.target.checked })} /> Izinkan cadangan aman pyRFC → Gateway</label>
          <small>Cadangan hanya sebelum eksekusi saat SDK atau pemetaan pyRFC belum tersedia. Penolakan izin dan kegagalan SAP tidak diulang melalui jalur lain.</small>
          <button className="button primary" disabled={busy} onClick={save}>Simpan Pengaturan</button>
          <label>Target SAP eksplisit<select value={target} disabled={busy} onChange={e => setTarget(e.target.value)}><option value="">Pilih target</option>{servers.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
          <small>Simpan perubahan sebelum menguji. Pengujian memakai RFC_SYSTEM_INFO pada jalur yang dipilih tanpa cadangan.</small>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}><button className="button" disabled={busy || !target || !config.enable_oidc_gateway} onClick={() => test('gateway')}>Uji Gateway</button><button className="button" disabled={busy || !target || !config.enable_pyrfc} onClick={() => test('pyrfc')}>Uji pyRFC</button></div>
          {busy && <div role="progressbar" aria-label="Memproses jembatan SAP">Memproses…</div>}
          {message && <div role={failed ? 'alert' : 'status'} className={`alert ${failed ? 'error' : 'success'}`}>{message}</div>}
        </div>
      </section>
    </div>}
  </>
}
