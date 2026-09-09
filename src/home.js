// Главная: витрина, список досок, вход.
//
// Раньше главной не было вообще. Приложение открывалось оверлеем со списком
// локальных проектов: человек, впервые открывший адрес, видел пустую сетку
// с надписью «Пока нет проектов» и не понимал ни что это за инструмент,
// ни где войти — кнопка «Войти» жила в подвале боковой панели, а боковая панель
// показывается только когда проект УЖЕ открыт. Дверь, открывающаяся изнутри.
//
// Модуль намеренно не знает про внутренности редактора: всё нужное приходит
// через init(). Иначе получилась бы вторая копия main.js.
import { api, ApiError } from './api.js';

let H = {};
export function initHome(host) { H = host; }

const esc = s => H.esc(s);
const $ = id => document.getElementById(id);
const errText = e => (e instanceof ApiError ? e.message : (e && e.message) || 'что-то пошло не так');

export const HOME = {
  view: 'all',      // all | shared | tpl | local | trash
  q: '',
  boards: null,     // ответ /api/boards, пока не загрузили — null
  loading: false,
};

/* ==========================================================================
   ПРЕВЬЮ ДОСКИ
   --------------------------------------------------------------------------
   Карточка без картинки — это строка текста: чтобы найти нужную доску, приходится
   читать названия одно за другим. Рисуем из настоящих координат узлов, которые
   клиент посчитал при последнем сохранении (см. buildPreview в main.js).
   ========================================================================== */
const PALETTE = ['#4262ff,#7b3fd1', '#0f8f6a,#2f9e6b', '#d2740c,#c9a227', '#8b46c9,#c94690', '#2f6fed,#0f8f6a'];
// Цвет заглушки детерминированный: одна и та же доска всегда одного цвета,
// иначе список «переливается» при каждой перерисовке и перестаёт узнаваться.
function coverFor(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const initials = name => String(name || '?').trim().slice(0, 1).toUpperCase() || '?';

function previewSVG(raw, id, name) {
  let p = null;
  try { p = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { p = null; }
  if (!p || !Array.isArray(p.n) || !p.n.length) {
    const [c1, c2] = coverFor(id).split(',');
    return `<div class="noprev" style="background:linear-gradient(135deg,${c1},${c2})">${esc(initials(name))}</div>`;
  }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y, w, h] of p.n) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  const pad = Math.max(40, (x1 - x0) * 0.04);
  x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  const edges = (p.e || []).map(([ax, ay, bx, by]) =>
    `<path d="M${ax} ${ay}L${bx} ${by}" stroke="#b9c1d1" stroke-width="${Math.max(2, (x1 - x0) / 300)}" fill="none"/>`).join('');
  const rx = Math.max(3, (x1 - x0) / 190);
  // Цветная полоса шире, чем на настоящем узле: на превью узел занимает считанные
  // пиксели, и полоска в 6% ширины сливается в серое — доска перестаёт узнаваться.
  const nodes = p.n.map(([x, y, w, h, c]) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="#fff" stroke="#d3d9e6" stroke-width="${rx / 2}"/>` +
    `<rect x="${x}" y="${y}" width="${Math.max(6, w * 0.16)}" height="${h}" rx="${rx / 2}" fill="${esc(c || '#9aa1b2')}"/>`).join('');
  // slice, а не meet: карта обычно сильно шире карточки, и «вписать целиком»
  // даёт бледную полоску в середине. Обрезка по центру читается как настоящий
  // кусок доски — по нему её и узнают в списке.
  return `<svg viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}" preserveAspectRatio="xMidYMid slice">${edges}${nodes}</svg>`;
}

/* ==========================================================================
   ПОКАЗ ЭКРАНОВ
   ========================================================================== */
function only(id) {
  for (const k of ['home', 'landing', 'authpage']) {
    const el = $(k);
    if (el) el.classList.toggle('open', k === id);
  }
  document.body.classList.toggle('onhome', !!id);
}
export function hideAll() { only(null); }
export function homeOpen() { return $('home').classList.contains('open') || $('landing').classList.contains('open'); }

/* ---------- относительное время ----------
   «12.03.2026» не отвечает на вопрос «свежая ли доска». «2 часа назад» отвечает. */
export function ago(t) {
  if (!t) return '';
  const d = (Date.now() - t) / 1000;
  if (d < 90) return 'только что';
  if (d < 3600) return `${Math.round(d / 60)} мин назад`;
  if (d < 86400) return `${Math.round(d / 3600)} ч назад`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)} дн назад`;
  return new Date(t).toLocaleDateString('ru-RU');
}

/* ==========================================================================
   АВАТАР И МЕНЮ АККАУНТА
   ========================================================================== */
export function initialsOf(acc) {
  if (!acc) return '?';
  const src = (acc.name || acc.email || '').trim();
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0] || '?')[0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

export function paintAvatars() {
  const acc = H.cloud.CLOUD.account;
  for (const id of ['hAvatar', 'bAvatar']) {
    const el = $(id); if (!el) continue;
    el.textContent = acc ? initialsOf(acc) : '?';
    el.classList.toggle('guest', !acc);
    el.title = acc ? `${acc.name || acc.email}${acc.admin ? ' · администратор' : ''}` : 'Войти';
  }
}

export function accountMenu(ev) {
  const acc = H.cloud.CLOUD.account;
  const el = ev && ev.currentTarget ? ev.currentTarget : $('hAvatar');
  const r = el.getBoundingClientRect();
  if (!acc) {
    if (H.cloud.CLOUD.online === false) { H.toast('Сервер недоступен — доски на сервере сейчас не открыть'); return; }
    return showAuthPage({ then: () => showHome('all') });
  }
  const items = [
    [acc.name || acc.email, null],
    ['—'],
    ['Мои доски', () => showHome('all')],
    ['Сменить пароль…', changePassword],
    ['Приложения…', showGrants],
    [H.isDark() ? 'Светлая тема' : 'Тёмная тема', () => { H.toggleTheme(); paintAvatars(); }],
    ['Справка', () => H.showHelp()],
  ];
  if (acc.admin) items.push(['—'], ['Админка', () => H.showAdmin()]);
  items.push(['—'], ['Выйти', async () => {
    await H.cloud.logout();
    H.cloud.unbindBoard();
    H.onSignedOut();
  }]);
  H.showCtx(r.right - 240, r.bottom + 8, items);
}

// Доступы, выданные по OAuth: коннектор Claude и что там ещё появится.
// Доступ, который нельзя отозвать, выдавать нельзя — поэтому этот экран
// появился одновременно с самой выдачей.
async function showGrants(msg) {
  let list = [];
  try { list = (await api.grants()).grants || []; } catch (e) { H.toast(errText(e)); return; }
  const when = t => t ? new Date(t).toLocaleString('ru-RU').slice(0, 16) : '—';
  H.modal(`<h3>Приложения с доступом</h3>
    <div class="kv hint" style="margin-bottom:10px">Это приложения, которым вы разрешили работать
      с вашими досками от вашего имени — например, коннектор Claude.</div>
    ${msg ? `<div class="kv" style="color:var(--green);font-size:12.5px">${esc(msg)}</div>` : ''}
    ${list.length ? list.map(g => `<div class="lrw" style="align-items:center;gap:10px">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:650">${esc(g.name || g.client_id)}</div>
        <div class="hint">доступ выдан ${esc(when(g.created_at))}${
          g.last_used ? ' · был ' + esc(when(g.last_used)) : ' · ещё не пользовались'}</div>
      </div>
      <button class="btn sm dgr" data-revoke="${esc(g.client_id)}">Отозвать</button>
    </div>`).join('') : '<div class="hint">Пока ни одному приложению доступ не выдан.</div>'}
    <div class="hint" style="margin-top:12px">Как подключить Claude: добавьте коннектор
      по адресу <b>${esc(location.origin)}/mcp</b> и войдите — доски станут доступны в чате.</div>
    <div class="mfoot"><button class="btn" data-a="c">Закрыть</button></div>`, b => {
    b.querySelector('[data-a=c]').onclick = H.closeModal;
    b.querySelectorAll('[data-revoke]').forEach(el => el.onclick = async () => {
      try { await api.grantRevoke(el.dataset.revoke); showGrants('Доступ отозван'); }
      catch (e) { H.toast(errText(e)); }
    });
  });
}

function changePassword() {
  H.modal(`<h3>Смена пароля</h3>
    <div class="f"><label>Текущий пароль</label><input type="password" id="pwCur"></div>
    <div class="f"><label>Новый пароль</label><input type="password" id="pwNew" placeholder="от 8 символов"></div>
    <div class="mfoot"><button class="btn" data-a="c">Отмена</button>
    <button class="btn pri" data-a="ok">Сменить</button></div>`, b => {
    b.querySelector('[data-a=c]').onclick = H.closeModal;
    b.querySelector('[data-a=ok]').onclick = async () => {
      try {
        await api.changePassword($('pwCur').value, $('pwNew').value);
        H.closeModal(); H.toast('Пароль изменён, остальные сессии закрыты');
      } catch (e) { H.toast(errText(e)); }
    };
  });
}

/* ==========================================================================
   ВХОД ОТДЕЛЬНЫМ ЭКРАНОМ
   --------------------------------------------------------------------------
   Было модальное окно поверх пустого списка проектов. Окно поверх пустоты
   не отвечает на вопрос «куда я попал» и исчезает от клика мимо — а вход
   это не всплывающая мелочь, это дверь.
   ========================================================================== */
export function showAuthPage(opts) {
  const o = opts || {};
  const invite = o.invite || null;
  let mode = o.mode || (invite ? 'register' : 'login');

  const draw = (msg) => {
    const reg = mode === 'register';
    $('authpage').innerHTML = `<div class="acard">
      <div class="brandline"><div class="logo" style="width:28px;height:28px;border-radius:8px;
        background:linear-gradient(135deg,#4262ff,#7b3fd1);display:flex;align-items:center;justify-content:center;
        color:#fff;font-weight:800;font-size:14px">G</div>
        <span style="font-weight:750;font-size:15px">Graph Studio</span></div>
      <h2>${reg ? 'Создание аккаунта' : 'Вход'}</h2>
      <div class="sub">${reg
        ? 'Приглашение принято. Осталось задать пароль — дальше доски будут ждать вас на любом устройстве.'
        : (o.reason ? esc(o.reason) : 'Доски живут на сервере и открываются с любого устройства.')}</div>
      ${msg ? `<div class="aerr">${esc(msg)}</div>` : ''}
      <div class="f"><label>Почта</label>
        <input type="email" id="auEmail" value="${esc(o.email || '')}" autocomplete="username" placeholder="you@example.com"></div>
      ${reg ? '<div class="f"><label>Как вас зовут</label><input type="text" id="auName" autocomplete="name" placeholder="Имя"></div>' : ''}
      <div class="f"><label>Пароль</label>
        <input type="password" id="auPass" autocomplete="${reg ? 'new-password' : 'current-password'}"
          placeholder="${reg ? 'от 8 символов' : ''}"></div>
      <button class="btn pri go" id="auGo">${reg ? 'Создать аккаунт' : 'Войти'}</button>
      <div class="alt">${invite ? '' : (reg
        ? 'Уже есть аккаунт? <a data-a="alt">Войти</a>'
        : 'Есть приглашение? <a data-a="alt">Зарегистрироваться</a>')}</div>
      <div class="alt"><a data-a="back">← На главную</a></div>
    </div>`;
    only('authpage');

    const alt = $('authpage').querySelector('[data-a=alt]');
    if (alt) alt.onclick = () => { mode = reg ? 'login' : 'register'; draw(); };
    $('authpage').querySelector('[data-a=back]').onclick = () => { H.goTo('/'); H.onSignedOut(); };

    const go = async () => {
      const email = $('auEmail').value.trim();
      const pass = $('auPass').value;
      if (!email || !pass) return draw('Заполните почту и пароль');
      $('auGo').disabled = true; $('auGo').textContent = 'Секунду…';
      try {
        const r = reg
          ? await api.register(email, pass, ($('auName') || {}).value || '', invite)
          : await api.login(email, pass);
        H.cloud.CLOUD.account = r.user;
        H.cloud.CLOUD.online = true;
        paintAvatars();
        H.toast(reg ? 'Аккаунт создан' : 'Вы вошли');
        if (o.then) o.then(); else showHome('all');
      } catch (e) {
        draw(errText(e));
      }
    };
    $('auGo').onclick = go;
    const enter = e => { if (e.key === 'Enter') go(); };
    $('auEmail').onkeydown = enter;
    $('auPass').onkeydown = enter;
    setTimeout(() => { const f = $(o.email ? 'auPass' : 'auEmail'); if (f) f.focus(); }, 30);
  };
  draw();
}

/* ==========================================================================
   ВИТРИНА
   ========================================================================== */
export function showLanding() {
  $('landing').innerHTML = `
  <div class="lhead">
    <div class="hbrand"><div class="logo">G</div><div class="nm">Graph Studio</div></div>
    <span class="hgrow"></span>
    <button class="btn" data-a="demo">Посмотреть демо</button>
    <button class="btn pri" data-a="login">Войти</button>
  </div>
  <div class="lwrap">
    <div class="lhero">
      <h1>Схема, на которой видно,<br>что чем заблокировано</h1>
      <p>Роадмапы, зависимости, процессы. Узлы и связи вместо списка задач: сразу
         понятно, в каком порядке всё физически может поехать и что держит запуск.</p>
      <div class="lcta">
        <button class="btn pri" data-a="login">Войти</button>
        <button class="btn" data-a="demo">Посмотреть демо без входа</button>
      </div>
      <div class="lnote">Регистрация по приглашению. Есть ссылка-приглашение — она сама откроет нужный экран.</div>
    </div>
    <div class="lshot">${heroArt()}</div>
    <div class="lfeat">
      <div class="c"><span class="ic">🔗</span><h3>Зависимости, а не даты</h3>
        <p>Колонка на карте — глубина зависимости. Наведите на узел: красным подсветится
           то, что его держит, зелёным — что он разблокирует.</p></div>
      <div class="c"><span class="ic">🗂</span><h3>Одни узлы, разные виды</h3>
        <p>Карта, свободная схема, таблица, канбан и дашборд — это страницы одного проекта.
           Меняется вид и фильтр, данные остаются одни.</p></div>
      <div class="c"><span class="ic">👥</span><h3>Доски на сервере</h3>
        <p>Доска открывается с любого устройства и делится ссылкой: на просмотр — без входа,
           на правку — с входом, чтобы у изменений был автор.</p></div>
    </div>
  </div>`;
  only('landing');
  $('landing').querySelectorAll('[data-a=login]').forEach(b => b.onclick = () => { H.goTo('/login'); showAuthPage({}); });
  $('landing').querySelectorAll('[data-a=demo]').forEach(b => b.onclick = () => H.openDemo());
  paintAvatars();
}

// Рисунок в героя — схематичный, но из настоящих элементов интерфейса:
// врать картинкой о том, как выглядит продукт, нельзя.
function heroArt() {
  return `<svg viewBox="0 0 940 400" xmlns="http://www.w3.org/2000/svg">
    <rect width="940" height="400" fill="#fbfcfe"/>
    <rect width="940" height="46" fill="#fff"/><line x1="0" y1="46" x2="940" y2="46" stroke="#e5e8f0"/>
    <rect x="18" y="15" width="16" height="16" rx="5" fill="#4262ff"/>
    <rect x="42" y="19" width="86" height="8" rx="4" fill="#c8cede"/>
    <rect x="800" y="13" width="76" height="20" rx="6" fill="#4262ff"/>
    <circle cx="900" cy="23" r="11" fill="#7b3fd1"/>
    <rect x="0" y="46" width="150" height="354" fill="#fff"/><line x1="150" y1="46" x2="150" y2="400" stroke="#e5e8f0"/>
    ${[0, 1, 2, 3].map(i => `<rect x="16" y="${72 + i * 30}" width="${96 - i * 12}" height="8" rx="4" fill="${i === 0 ? '#4262ff' : '#dfe3ec'}"/>`).join('')}
    <g stroke="#c3cad9" stroke-width="2" fill="none">
      <path d="M320 120 C 370 120, 370 96, 420 96"/><path d="M320 120 C 370 120, 370 176, 420 176"/>
      <path d="M580 96 C 630 96, 630 136, 680 136"/><path d="M580 176 C 630 176, 630 136, 680 136"/>
      <path d="M320 250 C 370 250, 370 256, 420 256"/><path d="M580 256 C 630 256, 630 176, 680 136"/>
    </g>
    ${[[190, 100, '#4262ff', 76, 52], [190, 230, '#d2740c', 66, 44]].map(([x, y, c, t, s]) =>
      `<rect x="${x}" y="${y}" width="130" height="42" rx="8" fill="#fff" stroke="#e5e8f0"/>
       <rect x="${x}" y="${y}" width="4" height="42" rx="2" fill="${c}"/>
       <rect x="${x + 14}" y="${y + 11}" width="${t}" height="7" rx="3.5" fill="#8f97a8"/>
       <rect x="${x + 14}" y="${y + 24}" width="${s}" height="6" rx="3" fill="#c8cede"/>`).join('')}
    ${[[450, 76, '#0f8f6a', 82, 50], [450, 156, '#8b46c9', 70, 58], [450, 236, '#b3261e', 74, 46]].map(([x, y, c, t, s]) =>
      `<rect x="${x}" y="${y}" width="130" height="42" rx="8" fill="#fff" stroke="#e5e8f0"/>
       <rect x="${x}" y="${y}" width="4" height="42" rx="2" fill="${c}"/>
       <rect x="${x + 14}" y="${y + 11}" width="${t}" height="7" rx="3.5" fill="#8f97a8"/>
       <rect x="${x + 14}" y="${y + 24}" width="${s}" height="6" rx="3" fill="#c8cede"/>`).join('')}
    <rect x="680" y="115" width="150" height="42" rx="21" fill="#fffdf6" stroke="#ecd8a0"/>
    <rect x="680" y="115" width="5" height="42" rx="2.5" fill="#8a5d00"/>
    <rect x="698" y="126" width="88" height="7" rx="3.5" fill="#8f97a8"/>
    <rect x="698" y="139" width="60" height="6" rx="3" fill="#c8cede"/>
    <rect x="166" y="340" width="140" height="34" rx="10" fill="#fff" stroke="#e5e8f0"/>
    <rect x="180" y="352" width="10" height="10" rx="2" fill="#8f97a8"/>
    <rect x="202" y="354" width="34" height="7" rx="3.5" fill="#c8cede"/>
    <rect x="248" y="354" width="44" height="7" rx="3.5" fill="#c8cede"/>
  </svg>`;
}

/* ==========================================================================
   СПИСОК ДОСОК
   ========================================================================== */
export async function showHome(view) {
  if (view) HOME.view = view;
  only('home');
  H.setBrowserTitle('Graph Studio — доски');
  paintAvatars();
  renderNav();
  renderMain();
  if (H.cloud.CLOUD.account && !HOME.loading) refreshBoards();
}

export async function refreshBoards() {
  if (!H.cloud.CLOUD.account) { HOME.boards = null; return; }
  HOME.loading = true;
  try {
    HOME.boards = await api.boards();
  } catch (e) {
    HOME.boards = null;
    H.toast('Не удалось получить список досок: ' + errText(e));
  } finally {
    HOME.loading = false;
  }
  if (homeOpen()) { renderNav(); renderMain(); }
}

const NAV = [
  ['all', '▦', 'Все доски'],
  ['shared', '👥', 'Со мной поделились'],
  ['tpl', '✦', 'Шаблоны'],
  ['local', '💾', 'На этом компьютере'],
  ['trash', '🗑', 'Корзина'],
];

function counts() {
  const b = HOME.boards || {};
  return {
    all: (b.mine || []).length + (b.shared || []).length,
    shared: (b.shared || []).length,
    tpl: H.TPL.length,
    local: H.localProjects().filter(p => !p.deleted).length,
    trash: (b.trashed || []).length + H.localProjects().filter(p => p.deleted).length,
  };
}

function renderNav() {
  const c = counts();
  const acc = H.cloud.CLOUD.account;
  $('hnav').innerHTML = NAV
    // Раздел «на этом компьютере» показывается, только если там что-то есть:
    // пустой пункт меню про хранилище, которого больше нет, только путает.
    .filter(([k]) => k !== 'local' || c.local > 0)
    .map(([k, ic, nm]) => `<div class="hn${HOME.view === k ? ' on' : ''}" data-v="${k}">
      <span class="ic">${ic}</span><span class="nm">${nm}</span>${c[k] ? `<span class="cnt">${c[k]}</span>` : ''}</div>`).join('')
    + `<div class="hnsep"></div>
       <div class="hn" data-a="help"><span class="ic">?</span><span class="nm">Справка</span></div>
       ${acc && acc.admin ? '<div class="hn" data-a="admin"><span class="ic">★</span><span class="nm">Админка</span></div>' : ''}`;
  $('hnav').querySelectorAll('[data-v]').forEach(el => el.onclick = () => { HOME.view = el.dataset.v; renderNav(); renderMain(); });
  $('hnav').querySelectorAll('[data-a=help]').forEach(el => el.onclick = () => H.showHelp());
  $('hnav').querySelectorAll('[data-a=admin]').forEach(el => el.onclick = () => H.showAdmin());
}

function matchQ(name) {
  const q = HOME.q.trim().toLowerCase();
  return !q || String(name || '').toLowerCase().includes(q);
}

function boardCard(b, kind) {
  const shared = kind === 'shared';
  return `<div class="bcard" data-b="${esc(b.id)}" data-kind="${kind}" tabindex="0">
    <div class="bprev">${previewSVG(b.preview, b.id, b.name)}</div>
    ${shared ? `<span class="tag">${b.role === 'editor' ? 'можно править' : 'только просмотр'}</span>` : ''}
    <button class="mo" data-menu="${esc(b.id)}" title="Действия">⋯</button>
    <div class="bbody">
      <div class="t">${esc(b.name || 'Без названия')}</div>
      <div class="m"><span>${H.nOf(b.nodes_count || 0, H.NODES)}</span><span class="dot">·</span>
        <span>${ago(b.updated_at)}</span></div>
      ${shared ? `<div class="who"><span class="avat sm">${esc(initialsOf({ email: b.owner_email }))}</span>
        ${esc(b.owner_email || 'коллега')}</div>` : ''}
    </div></div>`;
}

function localCard(p) {
  const moved = !!p.movedTo;
  return `<div class="bcard" data-loc="${esc(p.id)}" data-moved="${esc(p.movedTo || '')}" tabindex="0">
    <div class="bprev">${previewSVG(null, p.id, p.name)}</div>
    <span class="tag">${moved ? '✓ на сервере' : 'только здесь'}</span>
    <div class="bbody">
      <div class="t">${esc(p.name)}</div>
      <div class="m"><span>${H.nOf(p.nodes, H.NODES)}</span><span class="dot">·</span><span>${esc(p.updated || '')}</span></div>
      ${moved
        ? `<button class="btn sm" data-drop="${esc(p.id)}" style="margin-top:9px;width:100%;justify-content:center">
             Убрать копию из браузера</button>`
        : `<button class="btn sm pri" data-up="${esc(p.id)}" style="margin-top:9px;width:100%;justify-content:center">
             ↑ Перенести на сервер</button>`}
    </div></div>`;
}

function renderMain() {
  const m = $('hmain');
  const acc = H.cloud.CLOUD.account;
  const b = HOME.boards || {};
  const v = HOME.view;
  let head = '', body = '';

  if (v === 'tpl') {
    head = `<h1 class="hh1">Шаблоны</h1><div class="hsub">Готовая структура: типы узлов, статусы, страницы. Всё потом меняется в «Схеме проекта».</div>`;
    body = `<div class="bgrid">${H.TPL.map(t => `<div class="bcard" data-t="${esc(t.id)}" tabindex="0">
      <div class="bprev">${previewSVG(null, t.id, t.name)}</div>
      <div class="bbody"><div class="t">${esc(t.name)}</div>
      <div class="m" style="line-height:1.45">${esc(t.desc)}</div></div></div>`).join('')}</div>`;
  } else if (v === 'local') {
    const all = H.localProjects().filter(p => !p.deleted);
    const live = all.filter(p => matchQ(p.name));
    const left = all.filter(p => !p.movedTo).length;
    head = `<h1 class="hh1">На этом компьютере</h1>
      <div class="hsub">Проекты из прежней версии: они лежат только в этом браузере и не видны
        с других устройств. ${left ? 'Перенесите их на сервер — локальные копии останутся на месте, ' +
        'пока вы сами их не уберёте.' : 'Всё перенесено — копии можно убрать.'}</div>
      ${left ? `<div style="margin-bottom:18px"><button class="btn pri" data-a="upall">
        ↑ Перенести все на сервер (${left})</button></div>` : ''}`;
    body = live.length ? `<div class="bgrid">${live.map(localCard).join('')}</div>`
      : `<div class="bempty"><div class="ttl">Здесь пусто</div>Локальных проектов не осталось.</div>`;
  } else if (v === 'trash') {
    const st = (b.trashed || []).filter(x => matchQ(x.name));
    const lt = H.localProjects().filter(p => p.deleted).filter(p => matchQ(p.name));
    head = `<h1 class="hh1">Корзина</h1><div class="hsub">Доски отсюда можно вернуть.</div>`;
    body = (st.length || lt.length)
      ? `<div class="bgrid">${st.map(x => `<div class="bcard" style="opacity:.8" data-tr="${esc(x.id)}">
          <div class="bprev">${previewSVG(x.preview, x.id, x.name)}</div>
          <div class="bbody"><div class="t">${esc(x.name || 'Без названия')}</div>
          <div class="m">удалена ${ago(x.updated_at)}</div>
          <button class="btn sm" data-restore="${esc(x.id)}" style="margin-top:9px;width:100%;justify-content:center">Восстановить</button>
          </div></div>`).join('')
        + lt.map(p => `<div class="bcard" style="opacity:.8">
          <div class="bprev">${previewSVG(null, p.id, p.name)}</div>
          <div class="bbody"><div class="t">${esc(p.name)}</div>
          <div class="m">локальный · удалён ${esc(p.deletedAt || '')}</div>
          <div style="display:flex;gap:6px;margin-top:9px">
            <button class="btn sm" data-lrest="${esc(p.id)}">Вернуть</button>
            <button class="btn sm dgr" data-lpurge="${esc(p.id)}">Стереть</button></div>
          </div></div>`).join('')}</div>`
      : `<div class="bempty"><div class="ttl">Корзина пуста</div>Ничего удалённого нет.</div>`;
  } else {
    const mine = (b.mine || []).filter(x => matchQ(x.name));
    const shared = (b.shared || []).filter(x => matchQ(x.name));
    if (v === 'shared') {
      head = `<h1 class="hh1">Со мной поделились</h1><div class="hsub">Доски коллег, к которым вам дали доступ.</div>`;
      body = shared.length ? `<div class="bgrid">${shared.map(x => boardCard(x, 'shared')).join('')}</div>`
        : `<div class="bempty"><div class="ttl">Пока ничего</div>Когда вам пришлют ссылку на правку доски и вы по ней войдёте — доска появится здесь.</div>`;
    } else {
      head = `<h1 class="hh1">Доски</h1><div class="hsub">${HOME.loading && !HOME.boards ? 'Загружаю…'
        : `${mine.length + shared.length ? 'Открываются с любого устройства.' : ''}`}</div>`;
      if (!acc) {
        body = `<div class="bempty"><div class="ttl">Нужен вход</div>Доски живут на сервере.</div>`;
      } else if (HOME.boards === null) {
        body = HOME.loading ? `<div class="bempty">Загружаю…</div>`
          : `<div class="bempty"><div class="ttl">Список не пришёл</div>Сервер не ответил. Обновите страницу.</div>`;
      } else {
        const cards = [...mine.map(x => boardCard(x, 'mine')), ...shared.map(x => boardCard(x, 'shared'))];
        body = `<div class="bgrid">
          <div class="bcard new" data-a="new" tabindex="0"><span class="plus">＋</span>Новая доска</div>
          ${cards.join('')}</div>`;
        if (!cards.length && !HOME.q) {
          body = `<div class="bgrid">
            <div class="bcard new" data-a="new" tabindex="0"><span class="plus">＋</span>Новая доска</div>
            ${H.TPL.slice(0, 3).map(t => `<div class="bcard" data-t="${esc(t.id)}" tabindex="0">
              <div class="bprev">${previewSVG(null, t.id, t.name)}</div>
              <div class="bbody"><div class="t">${esc(t.name)}</div>
              <div class="m" style="line-height:1.45">${esc(t.desc)}</div></div></div>`).join('')}</div>`;
        }
        if (HOME.q && !cards.length) {
          body = `<div class="bempty"><div class="ttl">Ничего не нашлось</div>По запросу «${esc(HOME.q)}» досок нет.</div>`;
        }
      }
    }
  }
  m.innerHTML = `<div class="hwrap">${head}${body}</div>`;
  wireMain();
}

function wireMain() {
  const m = $('hmain');
  m.querySelectorAll('[data-a=new]').forEach(el => el.onclick = newBoard);
  m.querySelectorAll('[data-t]').forEach(el => el.onclick = () => H.createFromTemplate(el.dataset.t));
  m.querySelectorAll('[data-b]').forEach(el => el.onclick = e => {
    if (e.target.dataset.menu) { e.stopPropagation(); return cardMenu(e, el.dataset.b); }
    H.openBoard(el.dataset.b);
  });
  m.querySelectorAll('[data-a=upall]').forEach(el => el.onclick = () => H.uploadAllLocal());
  m.querySelectorAll('[data-loc]').forEach(el => el.onclick = e => {
    if (e.target.dataset.up) { e.stopPropagation(); return H.uploadLocal(e.target.dataset.up); }
    if (e.target.dataset.drop) { e.stopPropagation(); return H.purgeLocal(e.target.dataset.drop); }
    // Перенесённый проект открывается серверной доской: локальная копия здесь —
    // уже история, и правки в ней никуда бы не поехали.
    if (el.dataset.moved) return H.openBoard(el.dataset.moved);
    H.openLocal(el.dataset.loc);
  });
  m.querySelectorAll('[data-restore]').forEach(el => el.onclick = async e => {
    e.stopPropagation();
    try { await api.boardRestore(el.dataset.restore); H.toast('Доска восстановлена'); await refreshBoards(); }
    catch (err) { H.toast(errText(err)); }
  });
  m.querySelectorAll('[data-lrest]').forEach(el => el.onclick = e => { e.stopPropagation(); H.restoreLocal(el.dataset.lrest); });
  m.querySelectorAll('[data-lpurge]').forEach(el => el.onclick = e => { e.stopPropagation(); H.purgeLocal(el.dataset.lpurge); });
  // Клавиатура: сетка карточек проходится табом, значит должна открываться и Enter'ом.
  m.querySelectorAll('.bcard').forEach(el => el.onkeydown = e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); }
  });
}

function cardMenu(e, id) {
  const all = [...(HOME.boards.mine || []), ...(HOME.boards.shared || [])];
  const b = all.find(x => x.id === id); if (!b) return;
  const own = b.role === 'owner';
  const r = e.target.getBoundingClientRect();
  const items = [['Открыть', () => H.openBoard(id)]];
  if (own) items.push(
    ['Поделиться…', () => H.cloud.showShare(id, b.name)],
    ['Переименовать…', () => renameBoard(b)],
    ['—'],
    ['В корзину', () => H.confirmBox(`Убрать доску «${b.name}» в корзину? Её можно будет вернуть.`, async () => {
      try { await api.boardDelete(id); H.toast('Доска в корзине'); await refreshBoards(); }
      catch (err) { H.toast(errText(err)); }
    }, 'Убрать')],
  );
  H.showCtx(r.right - 236, r.bottom + 6, items);
}

// Переименование без открытия доски: имя лежит внутри документа, поэтому
// приходится прочитать документ, поменять поле и отправить обратно.
function renameBoard(b) {
  H.promptBox('Переименовать доску', 'Название', b.name || '', async (name) => {
    if (!name || !name.trim()) return;
    try {
      const cur = await api.boardGet(b.id);
      cur.doc.name = name.trim();
      await api.boardPut(b.id, cur.doc, cur.version);
      H.toast('Переименовано');
      await refreshBoards();
    } catch (e) { H.toast(errText(e)); }
  });
}

/* ---------- создание ---------- */
export function newBoard() {
  H.modal(`<h3>Новая доска</h3>
    <div class="kv hint" style="margin-bottom:12px">Шаблон задаёт стартовую структуру: типы узлов, статусы и страницы. Всё это потом меняется.</div>
    <div class="bgrid" style="grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px">
      ${H.TPL.map(t => `<div class="bcard" data-t="${esc(t.id)}" style="min-height:0" tabindex="0">
        <div class="bprev" style="height:74px">${previewSVG(null, t.id, t.name)}</div>
        <div class="bbody" style="padding:9px 11px 11px"><div class="t" style="font-size:13px">${esc(t.name)}</div>
        <div class="m" style="line-height:1.4">${esc(t.desc)}</div></div></div>`).join('')}
    </div>
    <div class="mfoot"><button class="btn" data-a="c">Отмена</button></div>`, b => {
    b.querySelector('[data-a=c]').onclick = H.closeModal;
    b.querySelectorAll('[data-t]').forEach(el => el.onclick = () => { H.closeModal(); H.createFromTemplate(el.dataset.t); });
  });
}

/* ---------- шапка ---------- */
export function wireHead() {
  $('hBrand').onclick = () => showHome('all');
  $('hNew').onclick = newBoard;
  $('hImport').onclick = () => H.importJson('new');
  $('hAvatar').onclick = accountMenu;
  const q = $('hq');
  let t = null;
  q.oninput = () => { clearTimeout(t); t = setTimeout(() => { HOME.q = q.value; renderMain(); }, 180); };
  q.onkeydown = e => { if (e.key === 'Escape') { q.value = ''; HOME.q = ''; renderMain(); } };
}
