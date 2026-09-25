let authMode = 'login';
let token = localStorage.getItem('re_bank_token') || '';
let cards = [];
let activeCardId = '';
let chartInstance = null;
let rouletteTimer = null;
let rouletteIndex = 0;
let rouletteResponse = null;
let rouletteStartedAt = 0;
let rouletteStopping = false;

const config = window.RE_BANK_CONFIG;
const apiBase = config.apiUrl.replace(/\/$/, '');

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

async function parseError(response) {
  try {
    const data = await response.json();
    if (typeof data.detail === 'string') return data.detail;
    if (data.detail?.message) return data.detail.message;
    return data.error || 'Request failed';
  } catch {
    return `Request failed with ${response.status}`;
  }
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${apiBase}${path}`, { ...options, headers });
  if (response.status === 401) {
    logout(false);
    throw new Error('Сессия завершена. Войдите снова.');
  }
  if (!response.ok) throw new Error(await parseError(response));
  return response.status === 204 ? null : response.json();
}

function setAuthMode(mode) {
  authMode = mode;
  $('login-tab').classList.toggle('active', mode === 'login');
  $('register-tab').classList.toggle('active', mode === 'register');
  $('auth-submit').textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
  $('auth-password').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  $('auth-email-field').classList.toggle('hidden', mode !== 'register');
  $('auth-email').required = mode === 'register';
  if (mode !== 'register') $('auth-email').value = '';
  $('auth-message').textContent = '';
}

async function handleAuth(event) {
  event.preventDefault();
  const username = $('auth-username').value.trim();
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  $('auth-submit').disabled = true;
  $('auth-message').textContent = '';
  try {
    const data = await api(authMode === 'login' ? '/auth/login' : '/auth/register', {
      method: 'POST',
      body: JSON.stringify(authMode === 'register' ? { username, email, password } : { username, password })
    });
    token = data.token;
    localStorage.setItem('re_bank_token', token);
    localStorage.setItem('re_bank_username', data.user.username);
    $('auth-form').reset();
    showScreen(true);
    await loadAll();
    toast(authMode === 'login' ? 'Добро пожаловать обратно' : 'Аккаунт создан и карта выпущена', 'ok');
  } catch (error) {
    $('auth-message').textContent = error.message;
  } finally {
    $('auth-submit').disabled = false;
  }
}

function logout(showMessage = true) {
  token = '';
  localStorage.removeItem('re_bank_token');
  localStorage.removeItem('re_bank_username');
  showScreen(false);
  if (showMessage) toast('Вы вышли из аккаунта');
}

function money(value) {
  return `$${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function crypto(value) {
  return `${Number(value || 0).toFixed(8)} BTC`;
}

function formatCardNumber(value) {
  const digits = String(value || '').replace(/\D/g, '').slice(0, 16);
  return digits.replace(/(.{4})/g, '$1 ').trim();
}

function renderCards() {
  const grid = $('cards-grid');
  grid.innerHTML = cards.map((card) => `
    <article class="card-shell">
      <div class="card-actions">
        <button class="icon-button" data-copy-card="${card.id}" title="Скопировать номер">⧉</button>
      </div>
      <div class="card-meta">
        <div class="text-sm font-extrabold tracking-wide">RE Банк</div>
        <div class="chip"></div>
      </div>
      <div class="card-number">${formatCardNumber(card.card_number)}</div>
      <div class="card-bottom">
        <div><div class="card-label">Card holder</div><div class="card-holder">${escapeHtml(card.card_holder)}</div><div class="mt-2 flex gap-4"><div><div class="card-label">Valid thru</div><div class="card-holder">${card.exp_date}</div></div><div><div class="card-label">CVV</div><div class="card-holder">${card.cvv}</div></div></div></div>
        <div class="text-right"><div class="card-label">Balance</div><div class="card-balance">${money(card.balance)}</div></div>
      </div>
    </article>
  `).join('');
  $('cards-limit-note').textContent = `${cards.length}/5 карт выпущено`;
  $('create-card-button').disabled = cards.length >= 5;
  grid.querySelectorAll('[data-copy-card]').forEach((button) => {
    button.addEventListener('click', async () => {
      const card = cards.find((item) => item.id === button.dataset.copyCard);
      if (!card) return;
      await navigator.clipboard.writeText(card.card_number);
      toast('Номер карты скопирован', 'ok');
    });
  });
  const select = $('active-card-select');
  const sellSelect = $('crypto-card-select');
  const oldActive = activeCardId;
  select.innerHTML = cards.map((card) => `<option value="${card.id}">${formatCardNumber(card.card_number)} — ${money(card.balance)}</option>`).join('');
  sellSelect.innerHTML = cards.map((card) => `<option value="${card.id}">${formatCardNumber(card.card_number)}</option>`).join('');
  activeCardId = cards.some((c) => c.id === oldActive) ? oldActive : cards[0]?.id || '';
  select.value = activeCardId;
  sellSelect.value = activeCardId;
  updateActiveCardUI();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
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
  const data = await api('/cards');
  cards = data.cards || [];
  renderCards();
}

async function loadDashboard() {
  const data = await api('/dashboard/stats');
  $('total-balance').textContent = money(data.total_balance);
  $('hero-crypto').textContent = crypto(data.crypto_balance);
  $('crypto-balance').textContent = crypto(data.crypto_balance);
  renderChart(data.chart || []);
}

function renderChart(points) {
  const ctx = $('balance-chart');
  const labels = points.map((p) => p.date.slice(5));
  const values = points.map((p) => p.total_balance);
  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{ data: values, borderColor: '#45d8ff', backgroundColor: 'rgba(69,216,255,.08)', borderWidth: 2, fill: true, tension: .38, pointRadius: 2, pointHoverRadius: 5 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { displayColors: false } },
      scales: { x: { grid: { display: false }, ticks: { color: '#6f7f98' } }, y: { grid: { color: 'rgba(255,255,255,.05)' }, ticks: { color: '#6f7f98', callback: (v) => money(v) } } }
    }
  });
}

async function loadRate() {
  const data = await api('/crypto/rate');
  $('crypto-rate').textContent = money(data.rate);
  $('hero-rate').textContent = money(data.rate);
}

async function loadRating() {
  const data = await api('/rating');
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
    await api('/cards/create', { method: 'POST', body: '{}' });
    await loadCards();
    await loadDashboard();
    toast('Новая карта выпущена', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    button.disabled = cards.length >= 5;
  }
}

async function clicker() {
  if (!activeCardId) return toast('Сначала выберите карту', 'err');
  const button = $('click-button');
  button.disabled = true;
  try {
    const data = await api('/click', { method: 'POST', body: JSON.stringify({ card_id: activeCardId }) });
    const card = cards.find((item) => item.id === activeCardId);
    if (card) card.balance = data.new_balance;
    renderCards();
    createFloat('+1$');
    $('clicker-balance').textContent = money(data.new_balance);
    await loadDashboard();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    setTimeout(() => button.disabled = false, 120);
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
  const receiver = $('receiver-card').value.replace(/\s/g, '');
  const amount = $('transfer-amount').value.trim();
  try {
    const data = await api('/transfers', { method: 'POST', body: JSON.stringify({ sender_card_id: activeCardId, receiver_card_number: receiver, amount }) });
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
  const button = $('earn-crypto-button');
  button.disabled = true;
  try {
    const data = await api('/crypto/earn', { method: 'POST', body: '{}' });
    $('crypto-balance').textContent = crypto(data.crypto_balance);
    $('hero-crypto').textContent = crypto(data.crypto_balance);
    $('crypto-message').textContent = `Получено ${data.earned_crypto} BTC`;
    toast('Пассивный доход получен', 'ok');
  } catch (error) {
    $('crypto-message').textContent = error.message;
    toast(error.message, 'err');
  } finally {
    setTimeout(() => button.disabled = false, 1000);
  }
}

async function sellCrypto(event) {
  event.preventDefault();
  const amount = $('crypto-amount').value.trim();
  const cardId = $('crypto-card-select').value;
  try {
    const data = await api('/crypto/sell', { method: 'POST', body: JSON.stringify({ card_id: cardId, amount_crypto: amount }) });
    $('crypto-balance').textContent = crypto(data.crypto_balance);
    $('hero-crypto').textContent = crypto(data.crypto_balance);
    const card = cards.find((item) => item.id === cardId);
    if (card) card.balance = data.card_balance;
    renderCards();
    await loadDashboard();
    $('sell-crypto-form').reset();
    $('crypto-card-select').value = cardId;
    toast(`Крипта продана на ${money(data.usd_amount)}`, 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function setRatingCard() {
  if (!activeCardId) return toast('Нет выбранной карты', 'err');
  try {
    await api('/user/select-rating-card', { method: 'POST', body: JSON.stringify({ card_id: activeCardId }) });
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
  const button = $('roulette-button');
  button.disabled = true;
  rouletteResponse = null;
  rouletteStopping = false;
  rouletteStartedAt = performance.now();
  $('roulette-result').textContent = 'Крутим…';
  const spinPromise = api('/roulette/spin', { method: 'POST', body: JSON.stringify({ card_id: activeCardId }) });
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
    button.disabled = false;
    $('roulette-result').textContent = error.message;
    return;
  }
}

function stopRoulette() {
  if (!rouletteResponse || rouletteStopping) return;
  rouletteStopping = true;
  clearInterval(rouletteTimer);
  rouletteTimer = null;
  const slot = rouletteResponse.winning_slot - 1;
  rouletteIndex = slot;
  setRouletteActive(slot, rouletteResponse.success);
  const message = rouletteResponse.success ? `🎉 Выигрыш ${money(rouletteResponse.win_amount)}!` : `Выпал слот ${rouletteResponse.winning_slot}. Удача была на ${rouletteResponse.lucky_slot}.`;
  $('roulette-result').textContent = message;
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
  const classes = ['c1','c2','c3','c4','c5'];
  for (let i = 0; i < 90; i += 1) {
    const piece = document.createElement('span');
    piece.className = `confetti ${classes[i % classes.length]}`;
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
$('crypto-card-select').addEventListener('change', (event) => { if (!activeCardId) activeCardId = event.target.value; });
$('set-rating-button').addEventListener('click', setRatingCard);
$('click-button').addEventListener('click', clicker);
$('transfer-form').addEventListener('submit', transfer);
$('earn-crypto-button').addEventListener('click', earnCrypto);
$('refresh-rate-button').addEventListener('click', loadRate);
$('sell-crypto-form').addEventListener('submit', sellCrypto);
$('roulette-button').addEventListener('click', spinRoulette);
$('receiver-card').addEventListener('input', (event) => {
  const digits = event.target.value.replace(/\D/g, '').slice(0, 16);
  event.target.value = formatCardNumber(digits);
});

buildRoulette();
setAuthMode('login');
if (token) {
  showScreen(true);
  loadAll().catch(() => logout(false));
} else {
  showScreen(false);
}

setInterval(() => {
  if (token && !$('app-screen').classList.contains('hidden')) loadRate().catch(() => {});
}, 10000);
setInterval(() => {
  if (token && !$('app-screen').classList.contains('hidden')) loadRating().catch(() => {});
}, 30000);
setInterval(() => {
  if (token && !$('app-screen').classList.contains('hidden')) loadDashboard().catch(() => {});
}, 15000);
