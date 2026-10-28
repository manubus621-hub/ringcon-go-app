/* JS app conductores */
(() => {
'use strict';

/* ═══════════════ CONFIGURACIÓN ═══════════════
   Debe ser IGUAL que en la app de pedidos (ringcon-go-delivery.html):
   misma FIREBASE_URL y mismo ROOM. Vacío = modo demo local (solo entre pestañas del mismo navegador). */
const CONFIG = {
  FIREBASE_URL: "https://project-979878097531856019-default-rtdb.firebaseio.com",
  ROOM: "ringcon-go",
  CURRENCY: "$",
  DRIVER_TTL: 120000
};

/* ═══════════════ SINCRONIZACIÓN EN TIEMPO REAL ═══════════════ */
const Sync = (() => {
  const remote = !!CONFIG.FIREBASE_URL;
  const base = remote ? CONFIG.FIREBASE_URL.replace(/\/+$/, '') + '/' + CONFIG.ROOM : '';
  const cols = ['orders', 'drivers'];
  const cache = { orders: {}, drivers: {} };
  const subs = { orders: new Set(), drivers: new Set() };
  const statusSubs = new Set();
  let status = remote ? 'connecting' : 'local';
  let done; const loaded = new Promise(r => (done = r));
  const key = c => `rcg:${CONFIG.ROOM}:${c}`;
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('rcg:' + CONFIG.ROOM) : null;
  const setStatus = s => { if (s !== status) { status = s; statusSubs.forEach(f => f(s)); } };
  const emit = c => subs[c].forEach(f => { try { f(cache[c]); } catch (e) { console.error(e); } });
  const readLocal = c => { try { return JSON.parse(localStorage.getItem(key(c)) || '{}') || {}; } catch { return {}; } };
  const refreshLocal = c => { cache[c] = readLocal(c); emit(c); };

  async function pull(c) {
    try {
      const r = await fetch(`${base}/${c}.json`, { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      cache[c] = (await r.json()) || {};
      setStatus('live'); emit(c);
    } catch (e) { setStatus('offline'); }
  }
  function start() {
    if (!remote) {
      cols.forEach(refreshLocal);
      if (bc) bc.onmessage = e => refreshLocal(e.data.c);
      addEventListener('storage', e => cols.forEach(c => { if (e.key === key(c)) refreshLocal(c); }));
      done(); return;
    }
    Promise.all(cols.map(pull)).then(done);
    cols.forEach(c => {
      try {
        const es = new EventSource(`${base}/${c}.json`);
        let t; const kick = () => { clearTimeout(t); t = setTimeout(() => pull(c), 120); };
        es.addEventListener('put', kick); es.addEventListener('patch', kick);
        es.onerror = () => setStatus('offline');
      } catch {}
    });
    setInterval(() => cols.forEach(pull), 8000);
  }
  async function patch(c, id, data) {
    if (!remote) {
      const all = readLocal(c); all[id] = Object.assign({}, all[id], data);
      try { localStorage.setItem(key(c), JSON.stringify(all)); } catch {}
      cache[c] = all; emit(c); if (bc) bc.postMessage({ c }); return;
    }
    cache[c][id] = Object.assign({}, cache[c][id], data); emit(c);
    const r = await fetch(`${base}/${c}/${id}.json`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), keepalive: true });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  }
  return {
    remote, loaded, start, patch,
    get: (c, id) => cache[c][id],
    refresh: c => remote ? pull(c) : Promise.resolve(refreshLocal(c)),
    subscribe(c, fn) { subs[c].add(fn); fn(cache[c]); },
    onStatus(fn) { statusSubs.add(fn); fn(status); },
    status: () => status
  };
})();

/* ═══════════════ UTILIDADES ═══════════════ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => CONFIG.CURRENCY + String(Math.round(Number(n || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const arr = x => Array.isArray(x) ? x : Object.values(x || {});
const hash = s => { let h = 5381; for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0; return h.toString(36); };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} }
};
let toastT;
function toast(msg, type) { const t = $('#toast'); t.textContent = msg; t.className = 'on ' + (type || ''); clearTimeout(toastT); toastT = setTimeout(() => t.className = '', 3400); }
const code = o => o.id.slice(-5).toUpperCase();
const VEH = { moto: ['🛵', 'Moto'], bici: ['🚲', 'Bici'], auto: ['🚗', 'Auto'] };

/* ═══════════════ ESTADO ═══════════════ */
const K = { me: 'rcg:driver', online: 'rcg:driver:online', sound: 'rcg:driver:sound' };
const state = { me: store.get(K.me, null), tab: 'orders', online: store.get(K.online, false), sound: store.get(K.sound, true), orders: {}, ready: false, veh: 'moto' };
const seen = new Set(), shown = new Set();

const allOrders = () => Object.values(state.orders);
const newOrders = () => allOrders().filter(o => o.status === 'nuevo').sort((a, b) => b.createdAt - a.createdAt);
const activeOrder = () => state.me ? allOrders().filter(o => o.driver && o.driver.id === state.me.id && ['aceptado', 'en_local', 'recogido'].includes(o.status)).sort((a, b) => b.updatedAt - a.updatedAt)[0] : null;

/* ═══════════════ ALERTAS (sonido, vibración, notificación) ═══════════════ */
let actx;
function ensureAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch {} }
function beep() {
  if (!state.sound || !actx) return;
  [0, .26, .52].forEach((t, i) => {
    const o = actx.createOscillator(), g = actx.createGain(), s = actx.currentTime + t;
    o.type = 'sine'; o.frequency.value = i === 2 ? 1175 : 880; o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(.0001, s); g.gain.exponentialRampToValueAtTime(.4, s + .02); g.gain.exponentialRampToValueAtTime(.0001, s + .22);
    o.start(s); o.stop(s + .25);
  });
}
let flashT; const baseTitle = document.title;
function flashTitle() {
  clearInterval(flashT); let on = false;
  flashT = setInterval(() => { on = !on; document.title = on ? '🔔 ¡Nuevo pedido!' : baseTitle; }, 800);
  const stop = () => { clearInterval(flashT); document.title = baseTitle; };
  addEventListener('focus', stop, { once: true }); setTimeout(stop, 30000);
}
function alertNew(o) {
  beep(); if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
  toast('🔔 Nuevo pedido · ganas ' + money(o.driverPay));
  if (document.hidden) {
    flashTitle();
    try { if (Notification.permission === 'granted') new Notification('Nuevo pedido · ' + money(o.driverPay), { body: o.business.name + ' → ' + o.address.text }); } catch {}
  }
}

/* ═══════════════ PRESENCIA DEL CONDUCTOR ═══════════════ */
function beat(offline) {
  if (!state.me) return;
  Sync.patch('drivers', state.me.id, { id: state.me.id, name: state.me.name, vehicle: VEH[state.me.vehicle][1], online: offline ? false : state.online, lastSeen: Date.now() }).catch(() => {});
}
setInterval(() => { if (state.me) beat(); }, 20000);
addEventListener('pagehide', () => beat(true));
addEventListener('pointerdown', ensureAudio, { once: true });

/* ═══════════════ VISTAS ═══════════════ */
function render() {
  if (!state.me) { renderLogin(); return; }
  $('#app').innerHTML = `
  <header class="top"><div class="top-in">
    <div><div class="logo">ringcon<b>go</b><em>conductores</em></div><p class="hi">Hola, <b>${esc(state.me.name)}</b> · ${VEH[state.me.vehicle][0]}</p></div>
    <div class="top-r"><button class="icon-btn" data-act="sound" aria-label="Sonido">${state.sound ? '🔔' : '🔕'}</button><button class="icon-btn" data-act="logout" aria-label="Cerrar sesión">⎋</button></div>
  </div></header>
  <main class="wrap" id="main"></main>
  <p class="foot" id="sync-chip"></p>
  <nav class="tabs" aria-label="Secciones">
    <button data-act="tab" data-t="orders">Pedidos<span class="bdg" id="bdg" style="display:none"></span></button>
    <button data-act="tab" data-t="earn">Ganancias</button>
  </nav>`;
  drawTab(); updateChip();
}
function renderLogin() {
  $('#app').innerHTML = `
  <main class="login">
    <div class="login-box">
      <svg class="ico" viewBox="0 0 512 512" aria-hidden="true"><rect width="512" height="512" rx="112" fill="#141416"/><path d="M256 104 388 398 256 332 124 398Z" fill="#ff3b1f" stroke="#ff3b1f" stroke-width="28" stroke-linejoin="round"/></svg>
      <h1>Conductores</h1>
      <p class="sub">Entra con tu nombre y empieza a recibir pedidos.</p>
      <form id="login-form">
        <label class="field">Tu nombre<input id="l-name" autocomplete="name" placeholder="Ej: Carlos" required maxlength="30"></label>
        <label class="field">Teléfono <i>(los clientes podrán llamarte)</i><input id="l-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="Opcional" maxlength="20"></label>
        <div class="field" style="margin-bottom:0">Tu vehículo</div>
        <div class="veh" id="veh">${Object.entries(VEH).map(([k, v]) => `<button type="button" data-act="veh" data-v="${k}" class="${k === state.veh ? 'on' : ''}"><span>${v[0]}</span>${v[1]}</button>`).join('')}</div>
        <button class="btn primary big">Empezar a conducir</button>
      </form>
    </div>
  </main>`;
}

function drawTab() {
  const el = $('#main'); if (!el) return;
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.t === state.tab));
  const news = newOrders(), bd = $('#bdg');
  if (bd) { bd.textContent = news.length; bd.style.display = news.length && state.online ? '' : 'none'; }
  el.innerHTML = state.tab === 'earn' ? earnHTML() : ordersHTML(news);
  news.forEach(o => shown.add(o.id));
  tickAgo();
}

function ordersHTML(news) {
  const act = activeOrder();
  const sw = `<section class="status ${state.online ? 'on' : ''}"><div><small>Tu estado</small><b>${state.online ? 'En línea' : 'Desconectado'}</b></div><button class="switch ${state.online ? 'on' : ''}" data-act="toggle" aria-label="${state.online ? 'Desconectarme' : 'Conectarme'}" aria-pressed="${state.online}"><i></i></button></section>`;
  if (act) return sw + activeHTML(act);
  if (!state.online) return sw + '<div class="radar"><div class="off-ic">😴</div><h2>Estás desconectado</h2><p>Conéctate para recibir pedidos en tiempo real.</p></div>';
  if (!news.length) return sw + '<div class="radar"><div class="r"><i></i></div><h2>Buscando pedidos…</h2><p>Te avisaremos con sonido y vibración apenas llegue uno.</p></div>';
  return sw + `<h2 class="sec">${news.length} pedido${news.length > 1 ? 's' : ''} disponible${news.length > 1 ? 's' : ''}</h2>` + news.map(cardHTML).join('');
}

function cardHTML(o) {
  const n = arr(o.items).reduce((s, i) => s + i.qty, 0), p = o.payment || {};
  return `
  <article class="ocard ${shown.has(o.id) ? '' : 'fresh'}">
    <div class="o-top"><span class="tag">Nuevo</span><span data-ts="${o.createdAt}"></span></div>
    <div class="money">${money(o.driverPay)}<small>ganancia</small></div>
    <div class="route">
      <div class="stop b"><small>Retira en</small><b>${esc(o.business.emoji)} ${esc(o.business.name)}</b></div>
      <div class="stop"><small>Entrega en</small><b>${esc(o.address.text)}</b></div>
    </div>
    <div class="chips"><span class="cp">${n} producto${n > 1 ? 's' : ''}</span><span class="cp">${p.method === 'tarjeta' ? '✓ Pagado online' : '💵 Cobrar ' + money(o.totals.total)}</span></div>
    <button class="btn white big" data-act="accept" data-id="${o.id}">Aceptar pedido</button>
  </article>`;
}

const FLOW = {
  aceptado: { next: 'en_local', label: 'Llegué al local', title: 'Ve al local', filled: 1 },
  en_local: { next: 'recogido', label: 'Recogí el pedido', title: 'Retira el pedido', filled: 2 },
  recogido: { next: 'entregado', label: 'Entregado', title: 'Lleva el pedido al cliente', filled: 3 }
};
function activeHTML(o) {
  const f = FLOW[o.status], p = o.payment || {}, items = arr(o.items);
  const dest = o.address.lat ? `${Number(o.address.lat)},${Number(o.address.lon)}` : encodeURIComponent(o.address.text);
  const phone = String((o.customer && o.customer.phone) || '').replace(/[^\d+]/g, '');
  const cashDue = p.method === 'efectivo' && p.status !== 'pagado';
  const payBlock = cashDue
    ? `<div class="cash"><small>Cobra al entregar</small><b>${money(o.totals.total)}</b>${p.cashWith ? `<small>Paga con ${money(p.cashWith)} · lleva ${money(p.cashWith - o.totals.total)} de cambio</small>` : ''}</div>`
    : `<div class="paid">✓ Ya pagado${p.brand ? ' con ' + esc(p.brand) : ''}. No cobres nada.</div>`;
  const last = o.status === 'recogido';
  return `
  <article class="active">
    <div class="seg">${[0, 1, 2, 3].map(i => `<i class="${i < f.filled ? 'on' : ''}"></i>`).join('')}</div>
    <h2>${f.title}</h2>
    <p style="opacity:.7">Pedido #${code(o)}</p>
    <div class="money">${money(o.driverPay)}<small>ganancia</small></div>
    <div class="route">
      <div class="stop b"><small>Retira en</small><b>${esc(o.business.emoji)} ${esc(o.business.name)}</b></div>
      <div class="stop"><small>Entrega a ${esc(o.customer.name)}</small><b>${esc(o.address.text)}</b>${o.address.ref ? `<small>${esc(o.address.ref)}</small>` : ''}</div>
    </div>
    ${payBlock}
    ${o.notes ? `<div class="note"><small>Nota del cliente</small>${esc(o.notes)}</div>` : ''}
    <div class="items">${items.map(i => `<span>${i.qty}× ${esc(i.name)}</span>`).join('')}</div>
    <div class="acts">
      ${o.status === 'recogido' || o.status === 'en_local'
        ? `<a href="https://www.google.com/maps/dir/?api=1&destination=${dest}" target="_blank" rel="noopener">🧭 Navegar</a>`
        : `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(o.business.name)}" target="_blank" rel="noopener">🧭 Buscar local</a>`}
      ${phone ? `<a href="tel:${esc(phone)}">📞 Llamar</a>` : `<a href="https://www.google.com/maps/dir/?api=1&destination=${dest}" target="_blank" rel="noopener">🧭 Ir al cliente</a>`}
    </div>
    <button class="btn primary big" data-act="advance" data-id="${o.id}">${last && cashDue ? 'Entregado · cobré ' + money(o.totals.total) : f.label}</button>
  </article>`;
}

function earnHTML() {
  const mine = allOrders().filter(o => o.driver && o.driver.id === state.me.id && o.status === 'entregado').sort((a, b) => (b.t_entregado || 0) - (a.t_entregado || 0));
  const dayStr = new Date().toDateString();
  const today = mine.filter(o => new Date(o.t_entregado || 0).toDateString() === dayStr);
  const sum = l => l.reduce((s, o) => s + Number(o.driverPay || 0), 0);
  const cash = today.filter(o => o.payment && o.payment.method === 'efectivo').reduce((s, o) => s + Number(o.totals.total || 0), 0);
  return `
  <section class="earn"><small>Ganado hoy</small><div class="big">${money(sum(today))}</div>
    <div class="two"><div><small>Entregas hoy</small><b>${today.length}</b></div><div><small>Efectivo cobrado</small><b>${money(cash)}</b></div></div>
  </section>
  <h2 class="sec">Historial</h2>
  ${mine.length ? mine.slice(0, 30).map(o => `<div class="hist"><div><b>${esc(o.business.emoji)} ${esc(o.business.name)}</b><small>#${code(o)} · ${new Date(o.t_entregado || o.updatedAt).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</small></div><b class="m">+${money(o.driverPay)}</b></div>`).join('') : '<p class="empty">Tus entregas aparecerán aquí.</p>'}
  <p class="foot">Total acumulado: ${money(sum(mine))}</p>`;
}

function tickAgo() {
  $$('[data-ts]').forEach(e => {
    const s = Math.max(0, Math.round((Date.now() - Number(e.dataset.ts)) / 1000));
    e.textContent = s < 60 ? `hace ${s} s` : s < 3600 ? `hace ${Math.floor(s / 60)} min` : 'hace más de 1 h';
  });
}
setInterval(tickAgo, 1000);
function updateChip() {
  const el = $('#sync-chip'); if (!el) return;
  const s = Sync.status();
  el.textContent = s === 'live' ? 'Sincronización en vivo activa' : s === 'local' ? 'Modo demo local · conecta Firebase para tiempo real entre dispositivos' : s === 'offline' ? 'Sin conexión · reintentando…' : 'Conectando…';
}

/* ═══════════════ ACCIONES ═══════════════ */
async function accept(id) {
  if (activeOrder()) { toast('Termina tu pedido actual primero', 'err'); return; }
  try {
    await Sync.refresh('orders');
    const o = Sync.get('orders', id);
    if (!o || o.status !== 'nuevo') { toast(o && o.status === 'cancelado' ? 'El cliente canceló este pedido' : 'Otro conductor ya tomó este pedido', 'err'); drawTab(); return; }
    const now = Date.now();
    await Sync.patch('orders', id, { status: 'aceptado', driver: { id: state.me.id, name: state.me.name, phone: state.me.phone || '', vehicle: VEH[state.me.vehicle][1] }, updatedAt: now, t_aceptado: now });
    await Sync.refresh('orders');
    const o2 = Sync.get('orders', id);
    if (!o2 || !o2.driver || o2.driver.id !== state.me.id) { toast('Otro conductor fue más rápido', 'err'); drawTab(); return; }
    toast('Pedido aceptado. ¡Ve al local!');
  } catch { toast('Sin conexión. Intenta de nuevo.', 'err'); }
}
async function advance(id) {
  const o = Sync.get('orders', id), f = o && FLOW[o.status]; if (!f) return;
  const cashDue = o.payment && o.payment.method === 'efectivo' && o.payment.status !== 'pagado';
  if (f.next === 'entregado' && !confirm(cashDue ? `¿Entregaste el pedido y cobraste ${money(o.totals.total)} en efectivo?` : '¿Confirmas que entregaste el pedido?')) return;
  const now = Date.now(), p = { status: f.next, updatedAt: now, ['t_' + f.next]: now };
  if (f.next === 'entregado' && cashDue) p.payment = { ...o.payment, status: 'pagado', collectedAt: now };
  try { await Sync.patch('orders', id, p); toast(f.next === 'entregado' ? '¡Entrega completada! +' + money(o.driverPay) : 'Listo'); }
  catch { toast('Sin conexión. Intenta de nuevo.', 'err'); }
}
function setOnline(v) {
  state.online = v; store.set(K.online, v);
  if (v) { ensureAudio(); try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch {} }
  beat(); drawTab(); toast(v ? 'Estás en línea. ¡A por pedidos!' : 'Te desconectaste');
}

const A = {
  tab: t => { state.tab = t.dataset.t; drawTab(); },
  toggle: () => setOnline(!state.online),
  accept: t => accept(t.dataset.id),
  advance: t => advance(t.dataset.id),
  sound: t => { state.sound = !state.sound; store.set(K.sound, state.sound); t.textContent = state.sound ? '🔔' : '🔕'; ensureAudio(); if (state.sound) beep(); toast(state.sound ? 'Sonido activado' : 'Sonido desactivado'); },
  veh: t => { state.veh = t.dataset.v; $$('#veh button').forEach(b => b.classList.toggle('on', b.dataset.v === state.veh)); },
  logout: () => {
    if (activeOrder()) { toast('Termina tu pedido en curso antes de salir', 'err'); return; }
    if (!confirm('¿Cerrar sesión? Dejarás de recibir pedidos.')) return;
    state.online = false; beat(true); store.del(K.me); store.del(K.online); state.me = null; render();
  }
};
document.addEventListener('click', e => { const t = e.target.closest('[data-act]'); if (!t) return; const f = A[t.dataset.act]; if (f) f(t, e); });
document.addEventListener('submit', e => {
  if (e.target.id !== 'login-form') return;
  e.preventDefault();
  const name = $('#l-name').value.trim().replace(/\s+/g, ' '), phone = $('#l-phone').value.trim();
  if (!name) return;
  ensureAudio();
  state.me = { id: 'd' + hash(name.toLowerCase() + '|' + phone), name, phone, vehicle: state.veh };
  store.set(K.me, state.me); render(); beat();
});

/* ═══════════════ TIEMPO REAL ═══════════════ */
function onOrders(data) {
  state.orders = data || {};
  if (!state.me) return;
  const news = newOrders();
  if (state.ready && state.online && !activeOrder()) {
    const fresh = news.filter(o => !seen.has(o.id));
    if (fresh.length) alertNew(fresh[0]);
  }
  news.forEach(o => seen.add(o.id));
  drawTab();
}
Sync.subscribe('orders', onOrders);
Sync.onStatus(updateChip);
Sync.start();
Sync.loaded.then(() => { newOrders().forEach(o => seen.add(o.id)); state.ready = true; if (state.me) beat(); });
addEventListener('online', () => toast('Conexión recuperada'));
addEventListener('offline', () => toast('Sin conexión a internet', 'err'));
render();
})();
