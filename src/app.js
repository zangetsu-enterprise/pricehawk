'use strict';
/* PriceHawk frontend — trackers live in localStorage, price checks via /api/check,
   PRO unlock via /api/verify (on-chain USDT verification). */

const FREE_LIMIT = 3;
const LS_TRACKERS = 'pricehawk_trackers_v1';
const LS_PRO = 'pricehawk_pro_v1';

const $ = (id) => document.getElementById(id);
const state = {
  trackers: load(LS_TRACKERS, []),
  pro: load(LS_PRO, null),
  pending: null, // result of last "Analyze URL"
};

function load(k, fb) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? fb; } catch { return fb; } }
function save(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

function fmt(price, currency) {
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD' }).format(price); }
  catch { return '$' + price.toFixed(2); }
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 2600);
}

/* ---------- plan / PRO ---------- */
function isPro() { return !!(state.pro && state.pro.tier); }
function refreshPlan() {
  const b = $('planBadge');
  b.textContent = isPro() ? 'PRO ' + (state.pro.tier === 'lifetime' ? '∞' : '') : 'FREE';
  b.className = 'plan-badge ' + (isPro() ? 'pro' : 'free');
  $('proBtn').textContent = isPro() ? 'PRO active ✓' : 'Go PRO';
}

/* ---------- add tracker flow ---------- */
$('analyzeBtn').onclick = async () => {
  const url = $('urlInput').value.trim();
  if (!url) return toast('Paste a product URL first.');
  $('analyzeBtn').disabled = true; $('analyzeBtn').textContent = 'Analyzing…';
  $('preview').classList.add('hidden'); $('addForm').classList.add('hidden');
  try {
    const r = await fetch('/api/check', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const d = await r.json();
    state.pending = d;
    const pv = $('preview');
    if (d.ok) {
      pv.innerHTML =
        (d.image ? `<img src="${esc(d.image)}" alt="">` : '') +
        `<div><div class="p-title">${esc(d.title || domainOf(url))}</div>` +
        `<div class="p-price">${fmt(d.price, d.currency)}</div>` +
        `<div class="p-mode">Auto price detection ${d.lowConfidence ? '(low confidence — verify the price)' : '✓'}</div></div>`;
      $('modeHint').textContent = 'We detected the price automatically. Set your target below it and we\'ll alert you when it drops.';
    } else {
      const reasons = { invalid_url: 'That URL looks invalid.', http_403: 'This store blocks automated checks.', http_404: 'Page not found (404).', timeout: 'The store took too long to respond.', fetch_error: 'Could not reach this store.', not_html: 'Not a product page.', no_price_found: 'No price found on this page.' };
      pv.innerHTML = `<div><div class="p-title">${esc(d.title || domainOf(url) || 'Product')}</div>` +
        `<div class="p-mode">⚠️ ${esc(reasons[d.reason] || 'Automatic detection unavailable.')} ` +
        `You can still track it in <strong>manual mode</strong>: enter the current price yourself and update it when you check.</div></div>`;
      $('modeHint').textContent = 'Manual mode: enter the CURRENT price in the first field, then the target price you\'d pay in the second. Use "Update price" on the card whenever you want a fresh check.';
    }
    pv.classList.remove('hidden'); $('addForm').classList.remove('hidden');
    // Manual mode: show the current-price field; auto mode: price already detected
    $('currentInput').classList.toggle('hidden', d.ok);
    $('currentInput').value = '';
    $('targetInput').value = '';
  } catch {
    toast('Network error — try again.');
  } finally {
    $('analyzeBtn').disabled = false; $('analyzeBtn').textContent = 'Analyze URL';
  }
};

$('addBtn').onclick = () => {
  const p = state.pending;
  if (!p) return;
  if (!isPro() && state.trackers.length >= FREE_LIMIT) { openPro(); return toast('Free plan = 3 trackers. Go PRO for unlimited.'); }
  const target = parseFloat($('targetInput').value);
  if (!Number.isFinite(target) || target <= 0) return toast('Enter a valid target price.');
  let startPrice;
  if (p.ok) {
    startPrice = p.price;
  } else {
    // Manual mode: current price comes from the visible input (never prompt())
    startPrice = parseFloat($('currentInput').value);
    if (!Number.isFinite(startPrice) || startPrice <= 0) return toast('Enter the current price in the first field.');
  }
  const t = {
    id: 't' + Date.now().toString(36),
    url: p.url, name: p.title || domainOf(p.url), image: p.image || '',
    currency: p.currency || 'USD', target,
    mode: p.ok ? 'auto' : 'manual',
    currentPrice: startPrice,
    history: [{ t: Date.now(), price: startPrice }],
    lastChecked: Date.now(), alerted: false,
  };
  state.trackers.unshift(t); save(LS_TRACKERS, state.trackers);
  $('urlInput').value = ''; $('targetInput').value = ''; $('currentInput').value = '';
  $('preview').classList.add('hidden'); $('addForm').classList.add('hidden'); state.pending = null;
  render(); toast('Tracking started 🦅');
};

/* ---------- checking ---------- */
async function checkTracker(t) {
  if (t.mode === 'manual') {
    const v = parseFloat(prompt(`Manual check — current price for "${t.name}"?`, String(t.currentPrice)) || '');
    if (Number.isFinite(v) && v > 0) pushPrice(t, v);
    return;
  }
  try {
    const r = await fetch('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: t.url }) });
    const d = await r.json();
    if (d.ok) pushPrice(t, d.price, d.title, d.image);
    else { t.lastChecked = Date.now(); t.checkNote = 'store blocked'; }
  } catch { t.checkNote = 'network error'; }
}

function pushPrice(t, price, title, image) {
  t.currentPrice = price; t.lastChecked = Date.now(); t.checkNote = '';
  if (title && !t.nameCustom) t.name = title;
  if (image && !t.image) t.image = image;
  const last = t.history[t.history.length - 1];
  if (!last || last.price !== price) t.history.push({ t: Date.now(), price });
  if (t.history.length > 120) t.history = t.history.slice(-120);
  save(LS_TRACKERS, state.trackers);
  if (price <= t.target && !t.alerted) {
    t.alerted = true; save(LS_TRACKERS, state.trackers);
    notify(`🎯 Price alert: ${t.name}`, `Now ${fmt(price, t.currency)} — at or below your ${fmt(t.target, t.currency)} target!`);
  } else if (price > t.target && t.alerted) {
    t.alerted = false; save(LS_TRACKERS, state.trackers); // re-arm
  }
}

$('checkAllBtn').onclick = async () => {
  if (!state.trackers.length) return toast('Nothing to check yet.');
  $('checkAllBtn').disabled = true; $('checkAllBtn').textContent = 'Checking…';
  for (const t of state.trackers) { await checkTracker(t); render(); }
  $('checkAllBtn').disabled = false; $('checkAllBtn').textContent = '🔄 Check all now';
  toast('All trackers checked.');
};

function notify(title, body) {
  renderAlerts();
  if ('Notification' in window) {
    if (Notification.permission === 'granted') new Notification(title, { body });
    else if (Notification.permission !== 'denied') Notification.requestPermission().then((p) => { if (p === 'granted') new Notification(title, { body }); });
  }
}

/* ---------- rendering ---------- */
function sparkline(history) {
  if (history.length < 2) return '';
  const w = 260, h = 44, vals = history.map((p) => p.price);
  const min = Math.min(...vals), max = Math.max(...vals), span = (max - min) || 1;
  const pts = vals.map((v, i) => `${(i / (vals.length - 1) * w).toFixed(1)},${(h - 4 - ((v - min) / span) * (h - 10)).toFixed(1)}`).join(' ');
  const down = vals[vals.length - 1] < vals[0];
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:44px"><polyline points="${pts}" fill="none" stroke="${down ? '#3fb950' : '#f85149'}" stroke-width="2"/></svg>`;
}

function renderAlerts() {
  const hits = state.trackers.filter((t) => t.currentPrice <= t.target);
  const box = $('alerts');
  if (!hits.length) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  box.classList.remove('hidden');
  box.innerHTML = hits.map((t) =>
    `<div class="alert">🎯 <b>${esc(t.name)}</b> is at <b>${fmt(t.currentPrice, t.currency)}</b> ` +
    `(target ${fmt(t.target, t.currency)}) — <a href="${esc(t.url)}" target="_blank" rel="noopener">buy now →</a></div>`
  ).join('');
}

function render() {
  renderAlerts();
  const g = $('grid');
  $('countLabel').textContent = `(${state.trackers.length}${isPro() ? '' : '/' + FREE_LIMIT + ' free'})`;
  $('empty').style.display = state.trackers.length ? 'none' : '';
  g.innerHTML = state.trackers.map((t) => {
    const hit = t.currentPrice <= t.target;
    const ago = t.lastChecked ? timeAgo(t.lastChecked) : 'never';
    return `<div class="tcard${hit ? ' hit' : ''}">
      <div class="tcard-top">
        ${t.image ? `<img src="${esc(t.image)}" alt="" loading="lazy">` : ''}
        <div><div class="t-name">${esc(t.name)}</div><div class="t-url">${esc(domainOf(t.url))}</div>
        <span class="badge ${t.mode}">${t.mode === 'auto' ? 'auto ✓' : 'manual'}</span>
        ${hit ? '<span class="badge hit">TARGET HIT 🎯</span>' : ''}</div>
      </div>
      <div class="t-prices"><div><div class="muted" style="font-size:.75rem">CURRENT</div><div class="cur">${fmt(t.currentPrice, t.currency)}</div></div>
      <div class="tgt"><div>TARGET</div><b>${fmt(t.target, t.currency)}</b></div></div>
      ${sparkline(t.history)}
      <div class="t-meta"><span>checked ${ago}${t.checkNote ? ' · ' + esc(t.checkNote) : ''}</span><span>${t.history.length} checks</span></div>
      <div class="t-actions">
        <button class="btn" data-act="check" data-id="${t.id}">${t.mode === 'auto' ? '↻ Check' : '✎ Update price'}</button>
        <button class="btn" data-act="target" data-id="${t.id}">🎯 Target</button>
        <a class="btn" href="${esc(t.url)}" target="_blank" rel="noopener">Buy →</a>
        <button class="btn danger" data-act="del" data-id="${t.id}">✕</button>
      </div>
    </div>`;
  }).join('');
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

$('grid').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]'); if (!btn) return;
  const t = state.trackers.find((x) => x.id === btn.dataset.id); if (!t) return;
  if (btn.dataset.act === 'del') {
    if (confirm('Stop tracking "' + t.name + '"?')) { state.trackers = state.trackers.filter((x) => x.id !== t.id); save(LS_TRACKERS, state.trackers); render(); }
  } else if (btn.dataset.act === 'target') {
    const v = parseFloat(prompt('New target price:', String(t.target)) || '');
    if (Number.isFinite(v) && v > 0) { t.target = v; t.alerted = t.currentPrice <= v; save(LS_TRACKERS, state.trackers); render(); }
  } else if (btn.dataset.act === 'check') {
    btn.disabled = true; await checkTracker(t); render();
  }
});

/* ---------- PRO modal ---------- */
const TIERS_UI = { monthly: '$12', lifetime: '$49' };
let activeTier = 'monthly';
const PAY_ADDR = '0xb2a38e074808f0c0d4ee9c13f5894c6c601fb172';

function openPro() { $('proModal').classList.remove('hidden'); paintTier(); }
function paintTier() {
  document.querySelectorAll('.tier').forEach((el) => el.classList.toggle('selected', el.dataset.tier === activeTier));
  $('payAmount').textContent = TIERS_UI[activeTier];
  $('payQr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=140x140&data=' + encodeURIComponent(PAY_ADDR);
  $('verifyMsg').textContent = ''; $('verifyMsg').className = 'verify-msg';
}
document.querySelectorAll('.tier').forEach((el) => { el.onclick = () => { activeTier = el.dataset.tier; paintTier(); }; });
$('proBtn').onclick = openPro;
$('proClose').onclick = () => $('proModal').classList.add('hidden');
$('proModal').addEventListener('click', (e) => { if (e.target === $('proModal')) $('proModal').classList.add('hidden'); });
$('copyAddr').onclick = () => { navigator.clipboard.writeText(PAY_ADDR).then(() => toast('Address copied. Remember: BSC network only.')); };

$('verifyBtn').onclick = async () => {
  const tx = $('txInput').value.trim();
  const msg = $('verifyMsg');
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) { msg.textContent = 'That doesn\'t look like a transaction hash (0x + 64 hex chars).'; msg.className = 'verify-msg err'; return; }
  msg.textContent = 'Checking the BSC blockchain…'; msg.className = 'verify-msg';
  $('verifyBtn').disabled = true;
  try {
    const r = await fetch('/api/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash: tx, tier: activeTier }) });
    const d = await r.json();
    if (d.valid) {
      state.pro = { tier: d.tier, txHash: d.txHash, amountUsdt: d.amountUsdt, at: Date.now() };
      save(LS_PRO, state.pro); refreshPlan(); render();
      msg.textContent = `✅ Payment confirmed (${d.amountUsdt} USDT). PRO ${d.tier} unlocked!`;
      msg.className = 'verify-msg ok';
      setTimeout(() => $('proModal').classList.add('hidden'), 1800);
    } else {
      const why = { invalid_hash_format: 'Invalid hash format.', tx_not_found: 'Transaction not found on BSC — check the hash.', tx_failed_or_reverted: 'That transaction failed on-chain.', not_a_usdt_transfer: 'That transaction is not a USDT transfer.', no_transfer_to_our_address: 'No USDT was sent to our address in that transaction.', amount_too_low: `Too low: received ${d.receivedUsdt} USDT, need ${d.requiredUsdt} USDT.`, chain_unreachable: 'Chain unreachable — try again in a minute.' };
      msg.textContent = '❌ ' + (why[d.reason] || 'Payment not verified.');
      msg.className = 'verify-msg err';
    }
  } catch { msg.textContent = 'Network error — try again.'; msg.className = 'verify-msg err'; }
  finally { $('verifyBtn').disabled = false; }
};

/* ---------- how-it-works ---------- */
const openHow = (e) => { e.preventDefault(); $('howModal').classList.remove('hidden'); };
$('howPayLink').onclick = openHow; $('howPayLink2').onclick = openHow;
$('howClose').onclick = () => $('howModal').classList.add('hidden');
$('howModal').addEventListener('click', (e) => { if (e.target === $('howModal')) $('howModal').classList.add('hidden'); });

/* auto-check on load */
refreshPlan(); render();
(async () => {
  for (const t of state.trackers.filter((t) => t.mode === 'auto')) { await checkTracker(t); }
  render();
})();

/* Enter in either price field = Start tracking */
[$('currentInput'), $('targetInput'), $('urlInput')].forEach((el) => {
  if (!el) return;
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (el === $('urlInput')) $('analyzeBtn').click();
      else $('addBtn').click();
    }
  });
});
