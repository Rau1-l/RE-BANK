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
let clickLevel = 0;
let clickValue = 1;
let adminPassword = '';
let adminPanel = '';
let appState = {};
let autoClickTimer = null;
let autoClickDisabled = false;
let chatWith = null;
let chatTimer = null;
let friendsCache = [];

const CLICKER_TIERS = [
  { level: 1, cost: 1000, value: 15 },
  { level: 2, cost: 5000, value: 35 },
  { level: 3, cost: 20000, value: 100 },
  { level: 4, cost: 100000, value: 300 },
  { level: 5, cost: 500000, value: 1000 }
];

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
  adminPassword = '';
  adminPanel = '';
  chatWith = null;
  if (chatTimer) { clearInterval(chatTimer); chatTimer = null; }
  if (autoClickTimer) { clearInterval(autoClickTimer); autoClickTimer = null; }
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
  const coinCardOptions = cards.map((card) => `<option value="${card.id}">${formatCardNumber(card.card_number)} — ${money(card.balance)}</option>`).join('');
  if ($('coin-card-select')) $('coin-card-select').innerHTML = coinCardOptions;
  if ($('coin-buy-card-select')) $('coin-buy-card-select').innerHTML = coinCardOptions;
  if ($('debt-card-select')) $('debt-card-select').innerHTML = coinCardOptions;
  if ($('loan-card-select')) $('loan-card-select').innerHTML = coinCardOptions;
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
  clickLevel = Number(data.click_level ?? 0);
  clickValue = Number(data.click_value ?? 1);
  renderCards();
  updateClicker();
}

function updateClicker() {
  const btn = $('click-button');
  if (btn) {
    for (let i = 0; i <= 5; i += 1) btn.classList.remove('lvl' + i);
    btn.classList.add('lvl' + clickLevel);
  }
  const pill = $('clicker-rate-pill');
  if (pill) pill.textContent = `+$${clickValue} за клик`;
  const next = CLICKER_TIERS.find((t) => t.level === clickLevel + 1);
  const info = $('clicker-upgrade-info');
  const ub = $('clicker-upgrade-button');
  if (!next) {
    if (info) info.textContent = 'Максимальный уровень достигнут 🎉';
    if (ub) ub.disabled = true;
  } else {
    if (info) info.textContent = `Уровень ${clickLevel}. Следующий: +$${next.value}/клик за ${money(next.cost)}`;
    if (ub) ub.disabled = false;
  }
}

async function upgradeClicker() {
  if (!activeCardId) return toast('Сначала выберите карту', 'err');
  $('clicker-upgrade-button').disabled = true;
  try {
    const data = await apiAction('clicker:upgrade', { card_id: activeCardId });
    clickLevel = Number(data.click_level);
    clickValue = Number(data.click_value);
    const card = cards.find((item) => item.id === activeCardId);
    if (card) card.balance = data.card_balance;
    renderCards();
    updateClicker();
    await loadDashboard();
    toast(`Кликер улучшен! Теперь +$${clickValue} за клик`, 'ok');
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    updateClicker();
  }
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
  await loadState().catch(() => {});
  await Promise.all([loadCards(), loadDashboard(), loadRate(), loadRating(), loadCoins(), loadReceipts(), loadFriends(), loadLoans()]);
  $('welcome-user').textContent = `Игрок · ${localStorage.getItem('re_bank_username') || 'RE'}`;
}

function coinAmount(value) {
  return Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 4 });
}

async function loadCoins() {
  const listNode = $('coins-list');
  if (!listNode) return;
  let data = [];
  try {
    data = await apiAction('coins:list');
  } catch (error) {
    listNode.innerHTML = `<div class="p-4 text-center text-slate-500">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!data.length) {
    listNode.innerHTML = '<div class="p-4 text-center text-slate-500">Пока нет монет. Создайте первую!</div>';
    return;
  }
  listNode.innerHTML = data.map((coin) => `
    <div class="rounded-2xl border border-white/5 bg-white/5 p-4">
      <div class="flex items-center justify-between gap-3">
        <div class="min-w-0">
          <div class="font-bold">${escapeHtml(coin.symbol)} <span class="text-slate-400 font-normal">· ${escapeHtml(coin.name)}</span></div>
          <div class="text-xs text-slate-500">Автор: ${escapeHtml(coin.owner)}${coin.is_owner ? ' (вы)' : ''} · цена ${money(coin.price_usd)} · выпущено ${coinAmount(coin.supply)}</div>
          <div class="text-xs text-emerald-300">Ваш баланс: ${coinAmount(coin.my_amount)} ${escapeHtml(coin.symbol)}</div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <input type="number" min="0" step="any" value="1" class="input !w-24 !py-2" data-coin-amount="${coin.id}">
          <button class="secondary-button purple" data-coin-buy="${coin.id}">Купить</button>
          <button class="secondary-button" data-coin-sell="${coin.id}">Продать</button>
          ${coin.is_owner ? `<button class="secondary-button danger" data-coin-del="${coin.id}">✕</button>` : ''}
        </div>
      </div>
    </div>
  `).join('');
  listNode.querySelectorAll('[data-coin-buy]').forEach((button) => button.addEventListener('click', () => buyCoin(button.dataset.coinBuy)));
  listNode.querySelectorAll('[data-coin-sell]').forEach((button) => button.addEventListener('click', () => sellCoin(button.dataset.coinSell)));
  listNode.querySelectorAll('[data-coin-del]').forEach((button) => button.addEventListener('click', () => deleteCoin(button.dataset.coinDel)));
}

async function sellCoin(coinId) {
  const cardId = $('coin-buy-card-select')?.value;
  if (!cardId) return toast('Сначала выпустите карту', 'err');
  const input = $('coins-list').querySelector(`[data-coin-amount="${coinId}"]`);
  const amount = (input?.value || '').trim();
  if (!amount || Number(amount) <= 0) return toast('Укажите количество', 'err');
  try {
    const data = await apiAction('coins:sell', { card_id: cardId, coin_id: coinId, amount });
    const card = cards.find((item) => item.id === cardId);
    if (card) card.balance = data.card_balance;
    renderCards();
    await Promise.all([loadCoins(), loadDashboard()]);
    toast(`Продано ${coinAmount(data.sold)} ${data.coin.symbol} за ${money(data.proceeds)}`, 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function deleteCoin(coinId) {
  if (!confirm('Удалить свою монету? Держателям вернётся вложенное.')) return;
  try {
    await apiAction('coins:delete', { coin_id: coinId });
    await Promise.all([loadCoins(), loadCards(), loadDashboard()]);
    toast('Монета удалена', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function buyCoin(coinId) {
  const cardId = $('coin-buy-card-select')?.value;
  if (!cardId) return toast('Сначала выпустите карту', 'err');
  const input = $('coins-list').querySelector(`[data-coin-amount="${coinId}"]`);
  const amount = (input?.value || '').trim();
  if (!amount || Number(amount) <= 0) return toast('Укажите количество', 'err');
  try {
    const data = await apiAction('coins:buy', { card_id: cardId, coin_id: coinId, amount });
    const card = cards.find((item) => item.id === cardId);
    if (card) card.balance = data.card_balance;
    renderCards();
    await Promise.all([loadCoins(), loadDashboard()]);
    toast(`Куплено ${coinAmount(data.bought)} ${data.coin.symbol} за ${money(data.cost)}`, 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function createCoin(event) {
  event.preventDefault();
  const cardId = $('coin-card-select')?.value;
  if (!cardId) return toast('Сначала выпустите карту', 'err');
  const payload = {
    card_id: cardId,
    name: $('coin-name').value.trim(),
    symbol: $('coin-symbol').value.trim(),
    invest: $('coin-invest').value.trim(),
    price: ($('coin-price')?.value || '1').trim()
  };
  try {
    const data = await apiAction('coins:create', payload);
    const card = cards.find((item) => item.id === cardId);
    if (card) card.balance = data.card_balance;
    renderCards();
    await Promise.all([loadCoins(), loadDashboard()]);
    $('coin-create-form').reset();
    $('coin-invest').value = '100';
    if ($('coin-price')) $('coin-price').value = '1';
    $('coin-create-message').textContent = `Монета ${data.coin.symbol} создана! Вы получили ${coinAmount(data.units)} монет.`;
    toast('Монета создана', 'ok');
  } catch (error) {
    $('coin-create-message').textContent = error.message;
    toast(error.message, 'err');
  }
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
    createFloat(`+$${clickValue}`);
    await loadDashboard();
  } catch (error) {
    toast(error.message, 'err');
  } finally {
    const delay = (appState.nodelay_until && new Date(appState.nodelay_until).getTime() > Date.now()) ? 0 : 120;
    setTimeout(() => $('click-button').disabled = false, delay);
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
  const spinPromise = apiAction('roulette:spin', { card_id: activeCardId, bet: 0 });
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
  $('roulette-result').textContent = rouletteResponse.success ? `🎉 Выигрыш ${money(rouletteResponse.win_amount)}! (слот ${rouletteResponse.winning_slot})` : `Выпал слот ${rouletteResponse.winning_slot}. Счастливые слоты: 66 и 77.`;
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

/* ===================== Админ-панель ===================== */
function openAdmin() {
  $('admin-overlay').classList.remove('hidden');
  if (adminPassword) {
    $('admin-login').classList.add('hidden');
    $('admin-content').classList.remove('hidden');
    const badge = $('admin-panel-badge');
    const mainTools = $('admin-main-tools');
    if (adminPanel === 'main') { if (badge) badge.classList.remove('hidden'); if (mainTools) mainTools.classList.remove('hidden'); loadAdminConfig(); }
    loadAdmin().catch((error) => toast(error.message, 'err'));
    return;
  }
  $('admin-login').classList.remove('hidden');
  $('admin-content').classList.add('hidden');
  $('admin-password').value = '';
  $('admin-login-message').textContent = '';
  if ($('admin-panel-badge')) $('admin-panel-badge').classList.add('hidden');
  if ($('admin-main-tools')) $('admin-main-tools').classList.add('hidden');
}

function closeAdmin() {
  $('admin-overlay').classList.add('hidden');
}

function adminLogoutPanel() {
  adminPassword = '';
  adminPanel = '';
  try { localStorage.removeItem('re_bank_panel_pw'); localStorage.removeItem('re_bank_panel_kind'); } catch (_e) { /* ignore */ }
  $('admin-content').classList.add('hidden');
  $('admin-login').classList.remove('hidden');
  $('admin-password').value = '';
  $('admin-login-message').textContent = '';
  if ($('admin-panel-badge')) $('admin-panel-badge').classList.add('hidden');
  if ($('admin-main-tools')) $('admin-main-tools').classList.add('hidden');
  toast('Вышли из панели', 'ok');
}

async function adminLogin() {
  const pw = $('admin-password').value;
  if (!pw) return;
  $('admin-login-button').disabled = true;
  $('admin-login-message').textContent = '';
  try {
    const res = await apiAction('admin:login', { password: pw });
    adminPassword = pw;
    adminPanel = res.panel || 'simple';
    try { localStorage.setItem('re_bank_panel_pw', pw); localStorage.setItem('re_bank_panel_kind', adminPanel); } catch (_e) { /* ignore */ }
    $('admin-login').classList.add('hidden');
    $('admin-content').classList.remove('hidden');
    const badge = $('admin-panel-badge');
    const mainTools = $('admin-main-tools');
    if (adminPanel === 'main') {
      if (badge) badge.classList.remove('hidden');
      if (mainTools) mainTools.classList.remove('hidden');
      await loadAdminConfig();
    } else {
      if (badge) badge.classList.add('hidden');
      if (mainTools) mainTools.classList.add('hidden');
    }
    await loadAdmin();
  } catch (error) {
    $('admin-login-message').textContent = error.message;
  } finally {
    $('admin-login-button').disabled = false;
  }
}

async function loadAdmin() {
  const data = await apiAction('admin:list', { password: adminPassword });
  $('admin-online').textContent = data.online;
  $('admin-total').textContent = (data.users || []).length;
  renderAdminUsers(data.users || [], data.online_ids || []);
}

function renderAdminUsers(users, onlineIds) {
  const onSet = new Set(onlineIds);
  const root = $('admin-users');
  root.innerHTML = users.map((u) => {
    const cardsHtml = (u.cards || []).map((c) => `
      <div class="admin-card-row">
        <span class="mono">${formatCardNumber(c.card_number)}</span>
        <span>${money(c.balance)}${c.frozen ? ' ❄️' : ''}</span>
        <input type="number" step="any" class="input admin-give-input" placeholder="+/− $" data-give-card="${c.id}">
        <button class="secondary-button" data-give-btn="${c.id}">Выдать</button>
        ${adminPanel === 'main' ? `<button class="secondary-button" data-freeze="${c.id}" data-frozen="${c.frozen ? '1' : '0'}">${c.frozen ? 'Разморозить' : 'Заморозить'}</button>` : ''}
      </div>`).join('');
    const mainActions = adminPanel === 'main'
      ? `<button class="secondary-button danger" data-block="${u.id}">Блок функции</button><button class="secondary-button" data-unblock="${u.id}">Снять блок</button>`
      : '';
    return `<div class="admin-user">
      <div class="admin-user-head">
        <div><b>${escapeHtml(u.username)}</b> ${onSet.has(u.id) ? '<span class="pill green">онлайн</span>' : '<span class="pill">оффлайн</span>'}</div>
        <div class="admin-user-actions">
          <button class="secondary-button" data-rename="${u.id}">Имя</button>
          <button class="secondary-button" data-setpw="${u.id}">Пароль</button>
          ${mainActions}
          <button class="secondary-button danger" data-del="${u.id}">Удалить</button>
        </div>
      </div>
      <div class="admin-user-meta">Пароль: <span class="mono">${escapeHtml(u.password || '—')}</span> · Крипта: ${cryptoText(u.crypto_balance)} · Кликер lvl ${u.click_level}</div>
      <div class="admin-cards">${cardsHtml || '<div class="text-xs text-slate-500">Нет карт</div>'}</div>
    </div>`;
  }).join('') || '<div class="p-4 text-center text-slate-500">Нет игроков</div>';

  root.querySelectorAll('[data-give-btn]').forEach((b) => b.addEventListener('click', () => {
    const cardId = b.dataset.giveBtn;
    const inp = root.querySelector(`[data-give-card="${cardId}"]`);
    adminGive(cardId, inp ? inp.value : '');
  }));
  root.querySelectorAll('[data-rename]').forEach((b) => b.addEventListener('click', () => adminRename(b.dataset.rename)));
  root.querySelectorAll('[data-setpw]').forEach((b) => b.addEventListener('click', () => adminSetPassword(b.dataset.setpw)));
  root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => adminDelete(b.dataset.del)));
  root.querySelectorAll('[data-freeze]').forEach((b) => b.addEventListener('click', () => adminFreeze(b.dataset.freeze, b.dataset.frozen !== '1')));
  root.querySelectorAll('[data-block]').forEach((b) => b.addEventListener('click', () => adminBlockUser(b.dataset.block)));
  root.querySelectorAll('[data-unblock]').forEach((b) => b.addEventListener('click', () => adminUnblockUser(b.dataset.unblock)));
}

async function adminGive(cardId, amount) {
  amount = String(amount || '').trim();
  if (!amount) return toast('Введите сумму', 'err');
  try {
    const data = await apiAction('admin:give', { password: adminPassword, card_id: cardId, amount });
    toast('Готово. Новый баланс ' + money(data.new_balance), 'ok');
    await loadAdmin();
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function adminReset() {
  if (!confirm('Обнулить балансы ВСЕХ карт у всех игроков?')) return;
  try {
    const data = await apiAction('admin:reset_all', { password: adminPassword });
    toast(`Обнулено карт: ${data.cards_reset}`, 'ok');
    await loadAdmin();
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function adminRename(userId) {
  const name = prompt('Новое имя пользователя (3-50 символов, без пробелов):');
  if (!name) return;
  try {
    await apiAction('admin:rename', { password: adminPassword, user_id: userId, username: name.trim() });
    toast('Имя изменено', 'ok');
    await loadAdmin();
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function adminSetPassword(userId) {
  const pw = prompt('Новый пароль (мин. 8 символов):');
  if (!pw) return;
  try {
    await apiAction('admin:set_password', { password: adminPassword, user_id: userId, new_password: pw });
    toast('Пароль изменён', 'ok');
    await loadAdmin();
  } catch (error) {
    toast(error.message, 'err');
  }
}

async function adminDelete(userId) {
  if (!confirm('Удалить этот аккаунт навсегда?')) return;
  try {
    await apiAction('admin:delete', { password: adminPassword, user_id: userId });
    toast('Аккаунт удалён', 'ok');
    await loadAdmin();
  } catch (error) {
    toast(error.message, 'err');
  }
}

/* ===================== State / налоги / бусты ===================== */
async function loadState() {
  const data = await apiAction('state');
  appState = data || {};
  applyState();
}

function applyState() {
  const debt = Number(appState.debt || 0);
  const pill = $('hero-debt-pill');
  if (pill) pill.classList.toggle('hidden', debt <= 0);
  if ($('hero-debt')) $('hero-debt').textContent = money(debt);
  if ($('debt-amount')) $('debt-amount').textContent = money(debt);
  const now = Date.now();
  const autoOn = appState.autoclick_until && new Date(appState.autoclick_until).getTime() > now;
  const noDelayOn = appState.nodelay_until && new Date(appState.nodelay_until).getTime() > now;
  const st = $('boost-status');
  if (st) {
    const parts = [];
    if (autoOn) parts.push(autoClickDisabled ? 'Автокликер остановлен ⏸️' : 'Автокликер активен ⚡');
    if (noDelayOn) parts.push('Без задержки 🚀');
    st.textContent = parts.join(' · ');
  }
  const stopBtn = $('boost-stop-button');
  if (stopBtn) {
    stopBtn.classList.toggle('hidden', !autoOn);
    stopBtn.textContent = autoClickDisabled ? '▶️ Включить автокликер' : '⬛ Остановить автокликер';
  }
  manageAutoClick(autoOn);
}

function manageAutoClick(on) {
  if (on && !autoClickDisabled && !autoClickTimer) {
    autoClickTimer = setInterval(() => {
      if (session && activeCardId && !$('app-screen').classList.contains('hidden')) clicker();
    }, 600);
  } else if ((!on || autoClickDisabled) && autoClickTimer) {
    clearInterval(autoClickTimer);
    autoClickTimer = null;
  }
}

async function buyBoost(kind) {
  if (!activeCardId) return toast('Сначала выберите карту', 'err');
  if (kind === 'auto') autoClickDisabled = false;
  try {
    const data = await apiAction('boost:buy', { card_id: activeCardId, kind });
    const card = cards.find((item) => item.id === activeCardId);
    if (card) card.balance = data.card_balance;
    renderCards();
    await loadState();
    await loadDashboard();
    toast('Буст активирован!', 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
}

/* ===================== Удвоитель ===================== */
async function spinDoubler() {
  if (!activeCardId) return toast('Выберите карту', 'err');
  const bet = ($('doubler-bet')?.value || '10').trim() || '10';
  const dial = $('doubler-dial');
  const btn = $('doubler-button');
  btn.disabled = true;
  if (dial) dial.classList.add('spin');
  $('doubler-result').textContent = 'Крутим…';
  try {
    const data = await apiAction('doubler:spin', { card_id: activeCardId, bet });
    const card = cards.find((item) => item.id === activeCardId);
    if (card) card.balance = data.new_balance;
    renderCards();
    await Promise.all([loadState(), loadDashboard()]);
    setTimeout(() => {
      if (dial) { dial.classList.remove('spin'); dial.textContent = data.success ? '+' + money(data.win_amount) : '✕'; dial.classList.toggle('win', !!data.success); dial.classList.toggle('lose', !data.success); }
      $('doubler-result').textContent = data.success ? `🎉 Выигрыш ${money(data.win_amount)}!` : `Проигрыш ${money(data.bet)}. Ставка ушла в казну.`;
      if (data.success) launchConfetti();
    }, 700);
  } catch (error) {
    if (dial) dial.classList.remove('spin');
    $('doubler-result').textContent = error.message;
  } finally {
    setTimeout(() => btn.disabled = false, 800);
  }
}

/* ===================== Долги ===================== */
async function payDebt() {
  const cardId = $('debt-card-select')?.value;
  if (!cardId) return toast('Выберите карту', 'err');
  const amount = ($('debt-amount-input')?.value || '').trim();
  try {
    const data = await apiAction('debt:pay', { card_id: cardId, amount });
    const card = cards.find((item) => item.id === cardId);
    if (card) card.balance = data.card_balance;
    renderCards();
    if ($('debt-amount-input')) $('debt-amount-input').value = '';
    await Promise.all([loadState(), loadDashboard(), loadReceipts()]);
    toast(`Оплачено ${money(data.paid)}. Остаток долга ${money(data.debt)}`, 'ok');
  } catch (error) {
    toast(error.message, 'err');
  }
}

/* ===================== Чеки ===================== */
async function loadReceipts() {
  const node = $('receipts-list');
  if (!node) return;
  let data = [];
  try { data = await apiAction('receipts:list'); } catch { return; }
  if (!data.length) { node.innerHTML = '<div class="p-4 text-center text-slate-500">Пока нет чеков</div>'; return; }
  node.innerHTML = data.map((r) => `
    <div class="flex items-center justify-between rounded-xl border border-white/5 bg-white/5 px-3 py-2 text-sm">
      <div><div class="font-semibold">${escapeHtml(r.title)}</div><div class="text-xs text-slate-500">${new Date(r.created_at).toLocaleString('ru-RU')}</div></div>
      <div class="font-bold ${Number(r.amount) < 0 ? 'text-rose-300' : 'text-emerald-300'}">${money(r.amount)}</div>
    </div>`).join('');
}

/* ===================== Друзья + чат ===================== */
async function loadFriends() {
  let data = {};
  try { data = await apiAction('friends:list'); } catch { return; }
  friendsCache = data.friends || [];
  const list = $('friends-list');
  if (list) list.innerHTML = friendsCache.length ? friendsCache.map((f) => `
    <div class="flex items-center justify-between rounded-xl border border-white/5 bg-white/5 px-3 py-2">
      <span class="font-semibold">${escapeHtml(f.username)}</span>
      <button class="secondary-button purple" data-chat="${f.id}" data-name="${escapeHtml(f.username)}">Чат</button>
    </div>`).join('') : '<div class="p-3 text-center text-slate-500 text-sm">Пока нет друзей</div>';
  if (list) list.querySelectorAll('[data-chat]').forEach((b) => b.addEventListener('click', () => openChat(b.dataset.chat, b.dataset.name)));
  const incoming = $('friend-incoming');
  const inc = data.incoming || [];
  if (incoming) incoming.innerHTML = inc.length ? ('<div class="text-xs text-slate-400 mb-1">Заявки в друзья:</div>' + inc.map((f) => `
    <div class="flex items-center justify-between rounded-xl border border-white/5 bg-white/5 px-3 py-2">
      <span>${escapeHtml(f.username)}</span>
      <button class="secondary-button" data-accept="${f.id}">Принять</button>
    </div>`).join('')) : '';
  if (incoming) incoming.querySelectorAll('[data-accept]').forEach((b) => b.addEventListener('click', () => acceptFriend(b.dataset.accept)));
  const sel = $('loan-lender-select');
  if (sel) sel.innerHTML = friendsCache.map((f) => `<option value="${f.id}">${escapeHtml(f.username)}</option>`).join('') || '<option value="">Нет друзей</option>';
}

async function searchFriends() {
  const q = ($('friend-search')?.value || '').trim();
  const node = $('friend-search-results');
  if (!q) { if (node) node.innerHTML = ''; return; }
  try {
    const data = await apiAction('users:search', { q });
    node.innerHTML = data.length ? data.map((u) => `
      <div class="flex items-center justify-between rounded-xl border border-white/5 bg-white/5 px-3 py-2">
        <span>${escapeHtml(u.username)}</span>
        <button class="secondary-button" data-addf="${u.id}">В друзья</button>
      </div>`).join('') : '<div class="p-2 text-center text-slate-500 text-sm">Никого не найдено</div>';
    node.querySelectorAll('[data-addf]').forEach((b) => b.addEventListener('click', () => requestFriend(b.dataset.addf)));
  } catch (error) { toast(error.message, 'err'); }
}

async function requestFriend(id) {
  try { await apiAction('friends:request', { friend_id: id }); toast('Заявка отправлена', 'ok'); await loadFriends(); }
  catch (error) { toast(error.message, 'err'); }
}

async function acceptFriend(id) {
  try { await apiAction('friends:accept', { friend_id: id }); toast('Друг добавлен', 'ok'); await loadFriends(); }
  catch (error) { toast(error.message, 'err'); }
}

function openChat(id, name) {
  chatWith = id;
  if ($('chat-title')) $('chat-title').textContent = 'Чат · ' + name;
  if ($('chat-input')) $('chat-input').disabled = false;
  if ($('chat-send')) $('chat-send').disabled = false;
  loadMessages();
  if (chatTimer) clearInterval(chatTimer);
  chatTimer = setInterval(() => { if (chatWith) loadMessages(); }, 4000);
}

async function loadMessages() {
  if (!chatWith) return;
  const box = $('chat-messages');
  if (!box) return;
  try {
    const data = await apiAction('chat:messages', { other_id: chatWith });
    box.innerHTML = data.map((m) => `<div class="chat-msg ${m.mine ? 'mine' : ''}">${escapeHtml(m.body)}</div>`).join('');
    box.scrollTop = box.scrollHeight;
  } catch { /* ignore */ }
}

async function sendMessage(event) {
  event.preventDefault();
  if (!chatWith) return toast('Выберите друга для чата', 'err');
  const input = $('chat-input');
  const text = (input?.value || '').trim();
  if (!text) return;
  try {
    await apiAction('chat:send', { to_id: chatWith, body: text });
    input.value = '';
    await loadMessages();
  } catch (error) { toast(error.message, 'err'); }
}

/* ===================== Займы ===================== */
async function loadLoans() {
  let data = {};
  try { data = await apiAction('loans:list'); } catch { return; }
  const inc = $('loans-incoming');
  const incoming = data.incoming || [];
  if (inc) inc.innerHTML = incoming.length ? ('<div class="text-xs text-slate-400 mb-1">Вам хотят занять:</div>' + incoming.map((l) => `
    <div class="flex items-center justify-between rounded-xl border border-white/5 bg-white/5 px-3 py-2 text-sm">
      <span>${escapeHtml(l.from)} → ${money(l.amount)} <span class="text-xs text-slate-500">(${escapeHtml(l.status)})</span></span>
      ${l.status === 'pending' ? `<button class="secondary-button purple" data-loan-accept="${l.id}">Дать займ</button>` : ''}
    </div>`).join('')) : '<div class="p-2 text-center text-slate-500 text-sm">Нет входящих</div>';
  if (inc) inc.querySelectorAll('[data-loan-accept]').forEach((b) => b.addEventListener('click', () => acceptLoan(b.dataset.loanAccept)));
  const mine = $('loans-mine');
  const mineArr = (data.mine || []).concat(data.lent || []);
  if (mine) mine.innerHTML = mineArr.length ? mineArr.map((l) => `
    <div class="flex items-center justify-between rounded-xl border border-white/5 bg-white/5 px-3 py-2 text-sm">
      <span>${escapeHtml(l.to || '')} · ${money(l.amount)}</span>
      <span class="text-xs text-slate-500">${escapeHtml(l.status)}</span>
    </div>`).join('') : '<div class="p-2 text-center text-slate-500 text-sm">Нет займов</div>';
}

async function requestLoan(event) {
  event.preventDefault();
  const lenderId = $('loan-lender-select')?.value;
  const cardId = $('loan-card-select')?.value;
  const amount = ($('loan-amount')?.value || '').trim();
  if (!lenderId) return toast('Сначала добавьте друга', 'err');
  if (!cardId) return toast('Выберите карту', 'err');
  try {
    await apiAction('loans:request', { lender_id: lenderId, amount, borrower_card: cardId });
    toast('Заявка на займ отправлена', 'ok');
    await loadLoans();
  } catch (error) { toast(error.message, 'err'); }
}

async function acceptLoan(loanId) {
  if (!activeCardId) return toast('Выберите активную карту, с которой дать займ', 'err');
  try {
    await apiAction('loans:accept', { loan_id: loanId, lender_card: activeCardId });
    await Promise.all([loadLoans(), loadCards(), loadDashboard()]);
    toast('Займ выдан', 'ok');
  } catch (error) { toast(error.message, 'err'); }
}

/* ===================== Блокировка сайта ===================== */
async function checkSiteLock() {
  const { data } = await supabase.functions.invoke('api', { body: { action: 'site:check', password: '' } });
  if (data && data.ok) return true;
  return await showSiteLock();
}

function showSiteLock() {
  return new Promise((resolve) => {
    const overlay = $('site-lock-overlay');
    overlay.classList.remove('hidden');
    const submit = async () => {
      const pw = $('site-lock-password').value;
      const { data } = await supabase.functions.invoke('api', { body: { action: 'site:check', password: pw } });
      if (data && data.ok) {
        overlay.classList.add('hidden');
        $('site-lock-button').removeEventListener('click', submit);
        resolve(true);
      } else {
        $('site-lock-message').textContent = 'Неверный пароль';
      }
    };
    $('site-lock-button').addEventListener('click', submit);
    $('site-lock-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  });
}

/* ===================== Главная админ-панель ===================== */
async function loadAdminConfig() {
  try {
    const cfg = await apiAction('admin:get_config', { password: adminPassword });
    if ($('cfg-treasury')) $('cfg-treasury').value = cfg.treasury_card || '';
    if ($('cfg-tax')) $('cfg-tax').value = cfg.tax_per_hour ?? '';
    if ($('cfg-penalty')) $('cfg-penalty').value = cfg.tax_penalty ?? '';
    if ($('cfg-site-on')) $('cfg-site-on').checked = !!cfg.site_password_on;
    if ($('gblock-status')) $('gblock-status').textContent = 'Глобальные блоки: ' + (Object.keys(cfg.global_blocks || {}).join(', ') || 'нет');
    const es = $('event-state');
    if (es) {
      const on = !!cfg.roulette_event_on;
      es.textContent = 'Статус: ' + (on ? 'ВКЛЮЧЁН 🎉' : 'выключен');
      es.classList.toggle('text-emerald-300', on);
      es.classList.toggle('text-slate-400', !on);
    }
    loadAdminCoins();
  } catch (error) { toast(error.message, 'err'); }
}

async function toggleEvent() {
  const es = $('event-state');
  const on = !(es && es.textContent.includes('ВКЛ'));
  try {
    await apiAction('admin:set_event', { password: adminPassword, on });
    toast(on ? 'Ивент включён' : 'Ивент выключен', 'ok');
    await loadAdminConfig();
  } catch (error) { toast(error.message, 'err'); }
}

async function loadAdminCoins() {
  const node = $('admin-coins-list');
  if (!node) return;
  let data = [];
  try {
    data = await apiAction('coins:list');
  } catch (error) {
    node.innerHTML = `<div class="text-xs text-slate-500">${escapeHtml(error.message)}</div>`;
    return;
  }
  if (!data.length) {
    node.innerHTML = '<div class="text-xs text-slate-500">Монет пока нет.</div>';
    return;
  }
  node.innerHTML = data.map((coin) => `
    <div class="flex items-center justify-between gap-2 rounded-xl border border-white/5 bg-white/5 px-3 py-2">
      <div class="min-w-0 text-sm">
        <span class="font-bold">${escapeHtml(coin.symbol)}</span>
        <span class="text-slate-400">· ${escapeHtml(coin.name)}</span>
        <div class="text-xs text-slate-500">Автор: ${escapeHtml(coin.owner)} · выпущено ${coinAmount(coin.supply)}</div>
      </div>
      <button class="secondary-button danger shrink-0" data-admin-coin-del="${coin.id}">Удалить</button>
    </div>
  `).join('');
  node.querySelectorAll('[data-admin-coin-del]').forEach((button) => button.addEventListener('click', () => adminCoinDelete(button.dataset.adminCoinDel)));
}

async function adminCoinDelete(coinId) {
  if (!confirm('Удалить эту монету? Держателям вернётся вложенное.')) return;
  try {
    await apiAction('admin:coin_delete', { password: adminPassword, coin_id: coinId });
    toast('Монета удалена', 'ok');
    await loadAdminCoins();
  } catch (error) { toast(error.message, 'err'); }
}

async function adminCoinDeleteAll() {
  if (!confirm('Удалить ВСЮ крипту всех игроков? Держателям вернётся вложенное.')) return;
  try {
    await apiAction('admin:coin_delete_all', { password: adminPassword });
    toast('Вся крипта удалена', 'ok');
    await loadAdminCoins();
  } catch (error) { toast(error.message, 'err'); }
}

async function saveAdminConfig() {
  const payload = { password: adminPassword };
  if ($('cfg-treasury')) payload.treasury_card = $('cfg-treasury').value.replace(/\s/g, '');
  if ($('cfg-tax') && $('cfg-tax').value !== '') payload.tax_per_hour = Number($('cfg-tax').value);
  if ($('cfg-penalty') && $('cfg-penalty').value !== '') payload.tax_penalty = Number($('cfg-penalty').value);
  if ($('cfg-site-on')) payload.site_password_on = $('cfg-site-on').checked;
  if ($('cfg-site-pw') && $('cfg-site-pw').value) payload.site_password = $('cfg-site-pw').value;
  if ($('cfg-main-pw') && $('cfg-main-pw').value) payload.main_password = $('cfg-main-pw').value;
  if ($('cfg-simple-pw') && $('cfg-simple-pw').value) payload.simple_password = $('cfg-simple-pw').value;
  try {
    await apiAction('admin:set_config', payload);
    if ($('cfg-site-pw')) $('cfg-site-pw').value = '';
    if ($('cfg-main-pw')) $('cfg-main-pw').value = '';
    if ($('cfg-simple-pw')) $('cfg-simple-pw').value = '';
    toast('Настройки сохранены', 'ok');
    await loadAdminConfig();
  } catch (error) { toast(error.message, 'err'); }
}

async function gblockChange(add) {
  const feature = $('gblock-feature')?.value || '';
  const minutes = Number($('gblock-minutes')?.value || '0');
  try {
    if (add) await apiAction('admin:block', { password: adminPassword, scope: 'all', feature, minutes });
    else await apiAction('admin:unblock', { password: adminPassword, scope: 'all', feature });
    toast(add ? 'Функция заблокирована всем' : 'Блок снят', 'ok');
    await loadAdminConfig();
  } catch (error) { toast(error.message, 'err'); }
}

async function adminFreeze(cardId, frozen) {
  try { await apiAction('admin:freeze', { password: adminPassword, card_id: cardId, frozen }); toast(frozen ? 'Карта заморожена' : 'Карта разморожена', 'ok'); await loadAdmin(); }
  catch (error) { toast(error.message, 'err'); }
}

async function adminBlockUser(userId) {
  const feature = prompt('Какую функцию заблокировать? (clicker, transfer, crypto, roulette, doubler, market)');
  if (!feature) return;
  const minutes = Number(prompt('На сколько минут? (0 = навсегда)', '0') || '0');
  try { await apiAction('admin:block', { password: adminPassword, scope: 'user', user_id: userId, feature: feature.trim(), minutes }); toast('Заблокировано', 'ok'); }
  catch (error) { toast(error.message, 'err'); }
}

async function adminUnblockUser(userId) {
  const feature = prompt('Какую функцию разблокировать?');
  if (!feature) return;
  try { await apiAction('admin:unblock', { password: adminPassword, scope: 'user', user_id: userId, feature: feature.trim() }); toast('Блок снят', 'ok'); }
  catch (error) { toast(error.message, 'err'); }
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
if ($('debt-pay-button')) $('debt-pay-button').addEventListener('click', payDebt);
$('coin-create-form').addEventListener('submit', createCoin);
$('refresh-coins-button').addEventListener('click', () => loadCoins().catch(() => {}));
$('coin-symbol').addEventListener('input', (event) => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); });
$('receiver-card').addEventListener('input', (event) => { event.target.value = formatCardNumber(event.target.value.replace(/\D/g, '').slice(0, 16)); });
$('clicker-upgrade-button').addEventListener('click', upgradeClicker);
$('admin-open-button').addEventListener('click', openAdmin);
$('admin-close-button').addEventListener('click', closeAdmin);
$('admin-login-button').addEventListener('click', adminLogin);
$('admin-password').addEventListener('keydown', (event) => { if (event.key === 'Enter') adminLogin(); });
$('admin-refresh-button').addEventListener('click', () => loadAdmin().catch((error) => toast(error.message, 'err')));
$('admin-reset-all-button').addEventListener('click', adminReset);
$('admin-logout-button').addEventListener('click', adminLogoutPanel);

// --- wiring that was previously missing (boosts, tax config, blocks, social) ---
const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
on('boost-auto-button', 'click', () => buyBoost('auto'));
on('boost-nodelay-button', 'click', () => buyBoost('nodelay'));
on('boost-stop-button', 'click', () => { autoClickDisabled = !autoClickDisabled; manageAutoClick(appState.autoclick_until && new Date(appState.autoclick_until).getTime() > Date.now()); applyState(); toast(autoClickDisabled ? 'Автокликер остановлен' : 'Автокликер снова работает', 'ok'); });
on('event-toggle-button', 'click', toggleEvent);
on('admin-coins-refresh', 'click', () => loadAdminCoins());
on('admin-coins-delete-all', 'click', adminCoinDeleteAll);
on('cfg-save-button', 'click', saveAdminConfig);
on('gblock-add', 'click', () => gblockChange(true));
on('gblock-remove', 'click', () => gblockChange(false));
on('receipts-refresh-button', 'click', () => loadReceipts().catch(() => {}));
on('friend-search-button', 'click', () => searchFriends().catch(() => {}));
on('friend-search', 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchFriends().catch(() => {}); } });
on('loans-refresh-button', 'click', () => loadLoans().catch(() => {}));
on('loan-form', 'submit', requestLoan);
on('chat-form', 'submit', sendMessage);

try {
  const savedPanelPw = localStorage.getItem('re_bank_panel_pw');
  if (savedPanelPw) { adminPassword = savedPanelPw; adminPanel = localStorage.getItem('re_bank_panel_kind') || 'simple'; }
} catch (_e) { /* ignore */ }

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
setInterval(() => { if (session && !$('app-screen').classList.contains('hidden')) loadFriends().catch(() => {}); }, 7000);
setInterval(() => { if (session && !$('app-screen').classList.contains('hidden')) loadLoans().catch(() => {}); }, 7000);
