import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, CircleAlert, KeyRound, Network, PlugZap, Server as ServerIcon, Settings2, ShieldCheck, X } from 'lucide-react'
import { api, post } from './api'
import type { Server } from './api'

type Config = { enable_pyrfc: boolean; enable_oidc_gateway: boolean; transport_priority: 'gateway' | 'pyrfc'; enable_transport_fallback: boolean }
type SdkStatus = { available: boolean; version?: string; reason?: string }
type Status = { config: Config; pyrfc?: SdkStatus; status?: string; identity_notice?: string }
type RfcTarget = { resource_key: string; name: string; ashost: string; sysnr: string; client: string; rfc_user: string; usable: boolean; source: string }
type Notice = { ok: boolean; text: string } | null

function Toggle({ checked, disabled, onChange, label }: { checked: boolean; disabled?: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} className={`sb-switch${checked ? ' on' : ''}`} onClick={() => onChange(!checked)}><span /></button>
}

export function SapTransportPanel() {
  const [allowed, setAllowed] = useState(false)
  const [open, setOpen] = useState(false)
  const [config, setConfig] = useState<Config | null>(null)
  const [saved, setSaved] = useState<Config | null>(null)
  const [sdk, setSdk] = useState<SdkStatus | null>(null)
  const [servers, setServers] = useState<Server[]>([])
  const [targets, setTargets] = useState<Record<string, RfcTarget>>({})
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [rowNotice, setRowNotice] = useState<Record<string, Notice>>({})

  useEffect(() => {
    api<Status>('/admin/sap-transport').then(r => { setConfig(r.config); setSaved(r.config); setAllowed(true) }).catch(() => setAllowed(false))
  }, [])

  const dirty = useMemo(() => JSON.stringify(config) !== JSON.stringify(saved), [config, saved])

  async function show() {
    setOpen(true); setNotice(null); setRowNotice({}); setBusy(true)
    try {
      const r = await api<Status>('/admin/sap-transport'); setConfig(r.config); setSaved(r.config); setSdk(r.pyrfc || null)
      const [s, t] = await Promise.all([
        api<{ resources: Server[] }>('/sap/servers'),
        api<{ targets: RfcTarget[] }>('/admin/sap-rfc-targets'),
      ])
      setServers(s.resources)
      setTargets(Object.fromEntries(t.targets.map(x => [x.resource_key, x])))
    } catch (e) { setNotice({ ok: false, text: String(e) }) }
    finally { setBusy(false) }
  }

  async function save() {
    setBusy(true); setNotice(null)
    try {
      const r = await api<Status>('/admin/sap-transport', { method: 'PUT', body: JSON.stringify(config) })
      setConfig(r.config); setSaved(r.config); setNotice({ ok: true, text: 'Pengaturan jembatan SAP tersimpan dan diaudit.' })
    } catch (e) { setNotice({ ok: false, text: String(e) }) }
    finally { setBusy(false) }
  }

  async function test(server: Server, route: 'gateway' | 'pyrfc') {
    const key = server.resource_key
    setBusy(true); setRowNotice(n => ({ ...n, [key]: null }))
    try {
      const r = await post<{ ok: boolean; message?: string; elapsed_ms?: number }>('/admin/sap-transport/test', { route, target: server.id })
      const name = route === 'gateway' ? 'Gateway' : 'pyRFC'
      setRowNotice(n => ({ ...n, [key]: { ok: r.ok, text: r.ok ? `${name}: koneksi berhasil (${r.elapsed_ms} ms).` : `${name}: ${r.message || 'uji koneksi gagal.'}` } }))
    } catch (e) { setRowNotice(n => ({ ...n, [key]: { ok: false, text: String(e) } })) }
    finally { setBusy(false) }
  }

  if (!allowed || !config) return null
  const set = (patch: Partial<Config>) => setConfig({ ...config, ...patch })
  const configured = servers.filter(s => targets[s.resource_key]?.usable).length

  return <>
    <button onClick={show}><Settings2 size={18} /> Jembatan SAP</button>
    {open && createPortal(<div className="modal-backdrop" onClick={() => !busy && setOpen(false)}>
      <section className="modal-card sb-modal" role="dialog" aria-modal="true" aria-labelledby="sap-transport-title" onClick={e => e.stopPropagation()}>
        <header className="sb-head">
          <div className="sb-head-icon"><Network size={18} /></div>
          <div><h2 id="sap-transport-title">Jembatan SAP</h2><p>Atur jalur koneksi SAP untuk Query Builder dan jadwal.</p></div>
          <button className="icon-button" aria-label="Tutup pengaturan SAP" disabled={busy} onClick={() => setOpen(false)}><X size={18} /></button>
        </header>

        <div className="sb-body">
          {!config.enable_pyrfc && !config.enable_oidc_gateway && <div className="alert error" role="alert">Semua akses SAP diblokir. Login OIDC dan laporan tersimpan tetap tersedia.</div>}

          <div className="sb-section-title">Jalur koneksi</div>
          <div className="sb-routes">
            <div className={`sb-route${config.enable_oidc_gateway ? ' active' : ''}`}>
              <div className="sb-route-top"><ShieldCheck size={18} /><strong>OIDC Gateway</strong><Toggle label="Aktifkan OIDC Gateway" checked={config.enable_oidc_gateway} disabled={busy} onChange={v => set({ enable_oidc_gateway: v })} /></div>
              <p>Memakai kredensial SAP pribadi pengguna. Tidak pernah beralih ke akun teknis.</p>
            </div>
            <div className={`sb-route${config.enable_pyrfc ? ' active' : ''}`}>
              <div className="sb-route-top"><PlugZap size={18} /><strong>Direct pyRFC</strong><Toggle label="Aktifkan Direct pyRFC (akun teknis)" checked={config.enable_pyrfc} disabled={busy} onChange={v => set({ enable_pyrfc: v })} /></div>
              <p>Koneksi langsung, hanya baca data, memakai akun RFC server yang sama dengan ABAP-Git. Tidak perlu atur server lagi.</p>
              {sdk && <span className={`sb-chip ${sdk.available ? 'ok' : 'warn'}`}>{sdk.available ? <><CheckCircle2 size={12} /> SDK pyrfc {sdk.version}</> : <><CircleAlert size={12} /> {sdk.reason}</>}</span>}
            </div>
          </div>

          <div className="sb-row">
            <div><strong>Prioritas jalur</strong><small>Jalur utama saat keduanya aktif.</small></div>
            <div className="sb-segment" role="radiogroup" aria-label="transport_priority">
              {(['gateway', 'pyrfc'] as const).map(p => <button key={p} type="button" role="radio" aria-checked={config.transport_priority === p} className={config.transport_priority === p ? 'on' : ''} disabled={busy} onClick={() => set({ transport_priority: p })}>{p === 'gateway' ? 'OIDC Gateway' : 'Direct pyRFC'}</button>)}
            </div>
          </div>
          <div className="sb-row">
            <div><strong>Cadangan aman pyRFC → Gateway</strong><small>Hanya sebelum eksekusi, saat SDK pyRFC belum tersedia atau server tidak punya akun RFC di ABAP-Git. Penolakan izin dan kegagalan SAP tidak diulang.</small></div>
            <Toggle label="Izinkan cadangan aman pyRFC → Gateway" checked={config.enable_transport_fallback} disabled={busy} onChange={v => set({ enable_transport_fallback: v })} />
          </div>

          <div className="sb-section-title">Server SAP <span>{configured}/{servers.length} siap pyRFC · akun dari ABAP-Git</span></div>
          <div className="sb-servers">
            {servers.length === 0 && <div className="sb-empty">{busy ? 'Memuat server…' : 'Tidak ada server SAP yang dapat Anda akses.'}</div>}
            {servers.map(s => {
              const t = targets[s.resource_key]
              const n = rowNotice[s.resource_key]
              const ready = !!t?.usable
              return <div key={s.resource_key} className="sb-server">
                <div className="sb-server-main">
                  <ServerIcon size={16} />
                  <div className="sb-server-name"><strong>{s.label}</strong><small>{s.resource_key}{ready ? ` · ${t.ashost} / ${t.sysnr} / ${t.client} · ${t.rfc_user}` : ''}</small></div>
                  <span className={`sb-chip ${ready ? 'ok' : 'muted'}`} title={t?.source}>{ready ? <><KeyRound size={11} /> pyRFC siap</> : t ? 'Hanya Gateway' : 'Tidak ada di ABAP-Git'}</span>
                  <div className="sb-server-actions">
                    <button className="button subtle" disabled={busy || !saved?.enable_oidc_gateway} title={saved?.enable_oidc_gateway ? '' : 'Aktifkan & simpan OIDC Gateway dulu'} onClick={() => test(s, 'gateway')}>Uji Gateway</button>
                    <button className="button subtle" disabled={busy || !saved?.enable_pyrfc || !ready} title={!saved?.enable_pyrfc ? 'Aktifkan & simpan Direct pyRFC dulu' : !ready ? 'Server ini tidak punya akun RFC di ABAP-Git' : ''} onClick={() => test(s, 'pyrfc')}>Uji pyRFC</button>
                  </div>
                </div>
                {n && <div role={n.ok ? 'status' : 'alert'} className={`sb-note ${n.ok ? 'ok' : 'err'}`}>{n.text}</div>}
              </div>
            })}
          </div>
        </div>

        <footer className="sb-foot">
          <div className="sb-foot-msg">
            {busy && <span role="progressbar" aria-label="Memproses jembatan SAP" className="sb-muted">Memproses…</span>}
            {!busy && notice && <span role={notice.ok ? 'status' : 'alert'} className={`sb-note ${notice.ok ? 'ok' : 'err'}`}>{notice.text}</span>}
            {!busy && !notice && dirty && <span className="sb-muted">Ada perubahan jalur yang belum disimpan.</span>}
          </div>
          <button className="button subtle" disabled={busy} onClick={() => setOpen(false)}>Tutup</button>
          <button className="button primary" disabled={busy || !dirty} onClick={save}>Simpan Pengaturan</button>
        </footer>
      </section>
    </div>, document.body)}
  </>
}
