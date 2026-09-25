import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const config = window.RE_BANK_CONFIG;
const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);
let authMode = 'login';
let session = null;
let cards = [];
let activeCardId = '';
let chartInstance = null;
let rouletteTimer = null;
let rouletteIndex = 0;
let rouletteResponse = null;
let rouletteStartedAt = 0;
let rouletteStopping = false;

const $ = (id) => document.getElementById(id);

function showScreen(authenticated) {
  $('auth-screen').classList.toggle('hidden', authenticated);
  $('auth-screen').classList.toggle('flex', !authenticated);
  $('app-screen').classList.toggle('hidden', !authenticated);
}

function toast(message, kind = '') {
  const node = $('toast');
  node.textContent = message;
  node.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.className = 'toast', 3200);
}

function setAuthMode(mode) {
  authMode = mode;
  $('login-tab').classList.toggle('active', mode === 'login');
  $('register-tab').classList.toggle('active', mode === 'register');
  $('auth-submit').textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
  $('auth-password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  $('auth-message').textContent = '';
}

function localEmail(username) {
  return `${username.trim().toLowerCase()}@rebank.local`;
}

async function invoke(functionName, body) {
  const { data, error } = await supabase.functions.invoke(functionName, {
    body,
    headers: session ? { Authorization: `Bearer ${session.access_token}` } : undefined
  });
  if (!error) return data;
  throw new Error(await functionErrorMessage(error));
}

async function functionErrorMessage(error) {
  const fallback = error?.message || 'Request failed';
  const context = error?.context;
  if (!context) return fallback;

  try {
    if (typeof context.json === 'function') {
      const payload = await context.json();
      return payload?.error || payload?.message || fallback;
    }
    if (typeof context.text === 'function') {
      const text = await context.text();
      if (text) {
        try {
          const payload = JSON.parse(text);
          return payload?.error || payload?.message || text;
        } catch {
          return text;
        }
      }
    }
    if (typeof context === 'object') {
      return context.error || context.message || fallback;
    }
  } catch {
    return fallback;
  }
  return fallback;
}

async function apiAction(action, payload = {}) {
  if (!session) throw new Error('Сессия завершена');
  return invoke('api', { action, ...payload });
}

async function handleAuth(event) {
  event.preventDefault();
  const username = $('auth-username').value.trim();
  const password = $('auth-password').value;
  $('auth-submit').disabled = true;
  $('auth-message').textContent = '';
  try {
    if (authMode === 'register') {
      await invoke('register', { username, password });
    }
    const signed = await supabase.auth.signInWithPassword({ email: localEmail(username), password });
    if (signed.error) throw new Error(signed.error.message);
    session = signed.data.session;
    localStorage.setItem('re_bank_username', username);
    showScreen(true);
    $('auth-form').reset();
    await loadAll();
    toast(authMode === 'login' ? 'Добро пожаловать обратно' : 'Аккаунт создан и карта выпущена', 'ok');
  } catch (error) {
    $('auth-message').textContent = error.message;
  } finally {
    $('auth-submit').disabled = false;
  }
}

async function logout(showMessage = true) {
  await supabase.auth.signOut();
  session = null;
  cards = [];
  activeCardId = '';
  showScreen(false);
  if (showMessage) toast('Вы вышли из аккаунта');
}

function money(value) {
  return `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function cryptoText(value) {
  return `${Number(value || 0).toFixed(8)} BTC`;
}

function formatCardNumber(value) {
  return String(value || '').replace(/\D/g, '').replace(/(.{4})/g, '$1 ').trim();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function renderCards() {
  $('cards-grid').innerHTML = cards.map((card) => `
    <article class="card-shell">
      <div class="card-actions"><button class="icon-button" data-copy-card="${card.id}" title="Скопировать номер">⧉</button></div>
      <div class="card-meta"><div class="text-sm font-extrabold tracking-wide">RE Банк</div><div class="chip"></div></div>
      <div class="card-number">${formatCardNumber(card.card_number)}</div>
      <div class="card-bottom">
        <div><div class="card-label">Card holder</div><div class="card-holder">${escapeHtml(card.card_holder)}</div><div class="mt-2 flex gap-4"><div><div class="card-label">Valid thru</div><div class="card-holder">${card.exp_date}</div></div><div><div class="card-label">CVV</div><div class="card-holder">${card.cvv}</div></div></div></div>
        <div class="text-right"><div class="card-label">Balance</div><div class="card-balance">${money(card.balance)}</div></div>
      </div>
    </article>
  `).join('');
  $('cards-limit-note').textContent = `${cards.length}/5 карт выпущено`;
  $('create-card-button').disabled = cards.length >= 5;
  $('cards-grid').querySelectorAll('[data-copy-card]').forEach((button) => button.addEventListener('click', async () => {
    const card = cards.find((item) => item.id === button.dataset.copyCard);
    if (!card) return;
    await navigator.clipboard.writeText(card.card_number);
    toast('Номер карты скопирован', 'ok');
  }));
  $('active-card-select').innerHTML = cards.map((card) => `<option value="${card.id}">${formatCardNumber(card.card_number)} — ${money(card.balance)}</option>`).join('');
  $('crypto-card-select').innerHTML = cards.map((card) => `<option value="${card.id}">${formatCardNumber(card.card_number)}</option>`).join('');
  activeCardId = cards.some((card) => card.id === activeCardId) ? activeCardId : cards[0]?.id || '';
  $('active-card-select').value = activeCardId;
  $('crypto-card-select').value = activeCardId;
  updateActiveCardUI();
}

function updateActiveCardUI() {
  const card = cards.find((item) => item.id === activeCardId);
  if (!card) {
    $('active-card-mini').innerHTML = '<div class="text-sm text-slate-500">Нет доступных карт</div>';
    $('clicker-balance').textContent = '$0.00';
    return;
  }
  $('active-card-mini').innerHTML = `<div class="text-xs text-slate-500">${formatCardNumber(card.card_number)}</div><div class="mt-1 text-xl font-extrabold">${money(card.balance)}</div><div class="mt-1 text-xs text-slate-400">${escapeHtml(card.card_holder)}</div>`;
  $('clicker-balance').textContent = money(card.balance);
}

async function loadCards() {
  const data = await apiAction('cards:list');
  cards = data.cards || [];
  renderCards();
}

async function loadDashboard() {
  const data = await apiAction('dashboard:stats');
  $('total-balance').textContent = money(data.total_balance);
  $('hero-crypto').textContent = cryptoText(data.crypto_balance);
  $('crypto-balance').textContent = cryptoText(data.crypto_balance);
  renderChart(data.chart || []);
}

function renderChart(points) {
  const labels = points.map((p) => p.date.slice(5));
  const values = points.map((p) => p.total_balance);
  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart($('balance-chart'), {
    type: 'line',
    data: { labels, datasets: [{ data: values, borderColor: '#45d8ff', backgroundColor: 'rgba(69,216,255,.08)', borderWidth: 2, fill: true, tension: .38, pointRadius: 2, pointHoverRadius: 5 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { displayColors: false } }, scales: { x: { grid: { display: false }, ticks: { color: '#6f7f98' } }, y: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#6f7f98', callback: (v) => money(v) } } } }
  });
}

async function loadRate() {
  const data = await apiAction('crypto:rate');
  $('crypto-rate').textContent = money(data.rate);
  $('hero-rate').textContent = money(data.rate);
}

async function loadRating() {
  const data = await apiAction('rating:list');
  $('rating-list').innerHTML = data.map((row) => {
    const medal = row.place === 1 ? '🥇' : row.place === 2 ? '🥈' : row.place === 3 ? '🥉' : row.place;
    return `<div class="rating-row"><div class="rating-place ${row.place <= 3 ? 'medal' : ''}">${medal}</div><div class="rating-name">${escapeHtml(row.username)}</div><div class="rating-balance">${money(row.balance)}</div></div>`;
  }).join('') || '<div class="p-6 text-center text-slate-500">Пока нет игроков</div>';
}

async function loadAll() {
  await Promise.all([loadCards(), loadDashboard(), loadRate(), loadRating()]);
  $('welcome-user').textContent = `Игрок · ${localStorage.getItem('re_bank_username') || 'RE'}`;
}

async function createCard() {
  const button = $('create-card-button');
  button.disabled = true;
  try {
    await apiAction('cards:create');
    await Promise.all([loadCards(), loadDashboard()]);
    toast('Новая карта выпущена', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = cards.length >= 5;
  }
}

async function clicker() {
  if (!activeCardId) return toast('Сначала выберите карту', 'err');
  $('click-button').disabled = true;
  try {
    const data = await apiAction('click', { card_id: activeCardId });
    const card = cards.find((item) => item.id === activeCardId);
    if (card) card.balance = data.new_balance;
    renderCards();
    createFloat('+1$');
    await loadDashboard();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    setTimeout(() => $('click-button').disabled = false, 120);
  }
}

function createFloat(text) {
  const node = document.createElement('div');
  node.className = 'float-coin';
  node.textContent = text;
  node.style.left = `${50 + (Math.random() * 25 - 12.5)}%`;
  node.style.top = `${50 + (Math.random() * 12 - 6)}%`;
  $('floating-text-layer').appendChild(node);
  setTimeout(() => node.remove(), 950);
}

async function transfer(event) {
  event.preventDefault();
  if (!activeCardId) return toast('Сначала выберите карту', 'err');
  try {
    const data = await apiAction('transfer', { sender_card_id: activeCardId, receiver_card_number: $('receiver-card').value.replace(/\s/g, ''), amount: $('transfer-amount').value.trim() });
    const sender = cards.find((card) => card.id === activeCardId);
    if (sender) sender.balance = data.sender_new_balance;
    renderCards();
    await loadDashboard();
    $('transfer-form').reset();
    $('transfer-result').innerHTML = '<div class="rounded-2xl border border-emerald-300/10 bg-emerald-300/5 px-4 py-3 text-sm text-emerald-200">Успешно переведено!</div>';
    toast('Перевод выполнен', 'ok');
  } catch (error) {
    $('transfer-result').innerHTML = `<div class="rounded-2xl border border-rose-300/10 bg-rose-300/5 px-4 py-3 text-sm text-rose-200">${escapeHtml(error.message)}</div>`;
  }
}

async function earnCrypto() {
  $('earn-crypto-button').disabled = true;
  try {
    const data = await apiAction('crypto:earn');
    $('crypto-balance').textContent = cryptoText(data.crypto_balance);
    $('hero-crypto').textContent = cryptoText(data.crypto_balance);
    $('crypto-message').textContent = `Получено ${data.earned_crypto} BTC`;
    toast('Пассивный доход получен', 'ok');
  } catch (error) {
    $('crypto-message').textContent = error.message;
    toast(error.message, 'err');
  } finally {
    setTimeout(() => $('earn-crypto-button').disabled = false, 1000);
  }
}

async function sellCrypto(event) {
  event.preventDefault();
  try {
    const cardId = $('crypto-card-select').value;
    const data = await apiAction('crypto:sell', { card_id: cardId, amount_crypto: $('crypto-amount').value.trim() });
    $('crypto-balance').textContent = cryptoText(data.crypto_balance);
    $('hero-crypto').textContent = cryptoText(data.crypto_balance);
    const card = cards.find((item) => item.id === cardId);
    if (card) card.balance = data.card_balance;
    renderCards();
    await loadDashboard();
    toast(`Крипта продана на ${money(data.usd_amount)}`, 'ok');
    $('sell-crypto-form').reset();
    $('crypto-card-select').value = cardId;
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function setRatingCard() {
  if (!activeCardId) return toast('Нет выбранной карты', 'err');
  try {
    await apiAction('rating:select', { card_id: activeCardId });
    await loadRating();
    toast('Карта установлена для глобального рейтинга', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
}

function buildRoulette() {
  $('roulette-grid').innerHTML = Array.from({ length: 100 }, (_, i) => `<div class="roulette-slot" data-slot="${i + 1}">${i + 1}</div>`).join('');
}

function setRouletteActive(index, winning = false) {
  const slots = $('roulette-grid').querySelectorAll('.roulette-slot');
  slots.forEach((slot, i) => slot.classList.toggle('active', i === index));
  if (winning) slots[index]?.classList.add('win');
}

async function spinRoulette() {
  if (!activeCardId || rouletteTimer) return toast('Выберите карту для рулетки', 'err');
  $('roulette-button').disabled = true;
  rouletteResponse = null;
  rouletteStopping = false;
  rouletteStartedAt = performance.now();
  $('roulette-result').textContent = 'Крутим…';
  const spinPromise = apiAction('roulette:spin', { card_id: activeCardId });
  rouletteTimer = setInterval(() => {
    rouletteIndex = (rouletteIndex + 1) % 100;
    setRouletteActive(rouletteIndex);
    if (rouletteResponse && !rouletteStopping && performance.now() - rouletteStartedAt >= 1800) stopRoulette();
  }, 55);
  try {
    rouletteResponse = await spinPromise;
    if (performance.now() - rouletteStartedAt >= 1800 && !rouletteStopping) stopRoulette();
  } catch (error) {
    clearInterval(rouletteTimer);
    rouletteTimer = null;
    $('roulette-button').disabled = false;
    $('roulette-result').textContent = error.message;
  }
}

function stopRoulette() {
  if (!rouletteResponse || rouletteStopping) return;
  rouletteStopping = true;
  clearInterval(rouletteTimer);
  rouletteTimer = null;
  rouletteIndex = rouletteResponse.winning_slot - 1;
  setRouletteActive(rouletteIndex, rouletteResponse.success);
  $('roulette-result').textContent = rouletteResponse.success ? `🎉 Выигрыш ${money(rouletteResponse.win_amount)}!` : `Выпал слот ${rouletteResponse.winning_slot}. Удача была на ${rouletteResponse.lucky_slot}.`;
  const card = cards.find((item) => item.id === activeCardId);
  if (card) card.balance = rouletteResponse.new_balance;
  renderCards();
  loadDashboard();
  if (rouletteResponse.success) launchConfetti();
  $('roulette-button').disabled = false;
}

function launchConfetti() {
  const layer = $('confetti-layer');
  layer.innerHTML = '';
  for (let i = 0; i < 90; i += 1) {
    const piece = document.createElement('span');
    piece.className = 'confetti';
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.setProperty('--x', `${Math.random() * 160 - 80}px`);
    piece.style.setProperty('--r', `${Math.random() * 900 - 450}deg`);
    piece.style.animationDelay = `${Math.random() * .35}s`;
    piece.style.background = ['#45d8ff','#b98aff','#35f29c','#ffcf5c','#ff77aa'][i % 5];
    layer.appendChild(piece);
  }
  setTimeout(() => layer.innerHTML = '', 2600);
}

$('login-tab').addEventListener('click', () => setAuthMode('login'));
$('register-tab').addEventListener('click', () => setAuthMode('register'));
$('auth-form').addEventListener('submit', handleAuth);
$('logout-button').addEventListener('click', () => logout(true));
$('create-card-button').addEventListener('click', createCard);
$('active-card-select').addEventListener('change', (event) => { activeCardId = event.target.value; updateActiveCardUI(); });
$('set-rating-button').addEventListener('click', setRatingCard);
$('click-button').addEventListener('click', clicker);
$('transfer-form').addEventListener('submit', transfer);
$('earn-crypto-button').addEventListener('click', earnCrypto);
$('refresh-rate-button').addEventListener('click', loadRate);
$('sell-crypto-form').addEventListener('submit', sellCrypto);
$('roulette-button').addEventListener('click', spinRoulette);
$('receiver-card').addEventListener('input', (event) => { event.target.value = formatCardNumber(event.target.value.replace(/\D/g, '').slice(0, 16)); });

buildRoulette();
setAuthMode('login');

const initial = await supabase.auth.getSession();
session = initial.data.session;
if (session) {
  showScreen(true);
  try { await loadAll(); } catch { await logout(false); }
} else {
  showScreen(false);
}

supabase.auth.onAuthStateChange((_event, nextSession) => { session = nextSession; if (!session) showScreen(false); });
setInterval(() => { if (session && !$('app-screen').classList.contains('hidden')) loadRate().catch(() => {}); }, 10000);
setInterval(() => { if (session && !$('app-screen').classList.contains('hidden')) loadRating().catch(() => {}); }, 30000);
setInterval(() => { if (session && !$('app-screen').classList.contains('hidden')) loadDashboard().catch(() => {}); }, 15000);
