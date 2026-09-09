// Серверная сторона в интерфейсе: вход, список досок, ссылки-доступы, админка.
//
// Модуль намеренно не знает про внутренности редактора: он получает нужные функции
// через init(), а не лезет в глобальные. Иначе получилась бы вторая копия main.js.
import { api, ApiError, parseRoute } from './api.js';

let H = {};   // мост к приложению: esc, modal, toast и прочее
export function initCloud(host) { H = host; }

export const CLOUD = {
  account: null,        // {id, email, name, admin} или null
  board: null,          // {id, version, role, asAdmin} если открыта серверная доска
  online: null,         // true / false / null пока не проверяли
  route: null,
};

/* ---------- вспомогательное ---------- */
const esc = s => H.esc(s);
const err = e => (e instanceof ApiError ? e.message : (e && e.message) || 'что-то пошло не так');

// Переход между экранами без перезагрузки. Адрес обязан меняться: ссылка,
// которую человек скопирует из строки браузера, должна вести туда же, куда он смотрит.
export function goTo(path, replace) {
  try { history[replace ? 'replaceState' : 'pushState']({}, '', path); } catch {}
  CLOUD.route = parseRoute(location.pathname);
}

/* ---------- вход ----------
   Экран входа живёт в src/home.js: это отдельный экран, а не окно поверх пустоты.
   Прежняя модальная реализация убрана, чтобы не расходились две формы входа. */

/* ---------- состояние аккаунта ---------- */
export async function loadAccount() {
  try {
    const r = await api.me();
    CLOUD.account = r.user;
    CLOUD.online = true;
  } catch (e) {
    // Сервера может не быть вообще (открыли собранный файл, сеть отвалилась).
    // Это не ошибка: приложение обязано продолжать работать с локальными проектами.
    CLOUD.account = null;
    CLOUD.online = false;
  }
  return CLOUD.account;
}

export async function logout() {
  try { await api.logout(); } catch {}
  CLOUD.account = null;
  CLOUD.board = null;
  H.toast('Вы вышли');
}

/* ---------- список серверных досок ---------- */
export async function fetchBoards() {
  if (!CLOUD.account) return null;
  try { return await api.boards(); } catch (e) { H.toast('Не удалось получить доски: ' + err(e)); return null; }
}

// Отдаёт локальный проект на сервер. Это же путь переезда: ничего не удаляется,
// локальная копия остаётся на месте, пока человек сам не решит иначе.
export async function uploadProject(doc, preview) {
  const r = await api.boardCreate(doc, preview);
  return r.id;
}

/* ---------- ссылки-доступы ---------- */
export function showShare(boardId, boardName) {
  const draw = async (msg) => {
    let data = {shares: [], members: []};
    try { data = await api.shares(boardId); } catch (e) { msg = msg || err(e); }
    const live = data.shares.filter(s => !s.revoked && (!s.expires_at || s.expires_at > Date.now()));
    const link = t => location.origin + t;
    H.modal(`<h3>Доступ к доске</h3>
      <div class="kv" style="font-size:12.5px">«${esc(boardName || '')}»</div>
      ${msg ? `<div class="kv" style="color:var(--red);font-size:12.5px">${esc(msg)}</div>` : ''}

      <div class="sect">Ссылки</div>
      ${live.length ? live.map(s => `<div class="lrw" style="align-items:center">
        <input type="text" readonly value="${esc(link((s.role === 'editor' ? '/e/' : '/s/') + s.token))}"
          data-copy style="font-size:11.5px">
        <span class="chip" style="cursor:default">${s.role === 'editor' ? 'правка' : 'просмотр'}</span>
        <button class="ib dgr" data-revoke="${esc(s.token)}" title="отозвать">×</button>
      </div>`).join('') : '<div class="hint">Ссылок пока нет.</div>'}
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn" data-new="viewer">＋ Ссылка на просмотр</button>
        <button class="btn" data-new="editor">＋ Ссылка на правку</button>
      </div>
      <div class="hint" style="margin-top:8px">
        По ссылке на просмотр доска открывается без входа. Ссылка на правку требует входа —
        иначе у изменений не будет автора и в истории не станет видно, кто что поменял.
      </div>

      <div class="sect">Участники</div>
      ${data.members.length ? data.members.map(m => `<div class="kv">
        <b>${esc(m.email)}</b> — ${m.role === 'owner' ? 'владелец' : m.role === 'editor' ? 'может править' : 'только смотрит'}</div>`).join('')
        : '<div class="hint">Пока только вы.</div>'}

      <div class="mfoot"><button class="btn" data-a="c">Закрыть</button></div>`, b => {
      b.querySelector('[data-a=c]').onclick = H.closeModal;
      b.querySelectorAll('[data-copy]').forEach(inp => {
        inp.onclick = () => {
          inp.select();
          try { navigator.clipboard.writeText(inp.value); H.toast('Ссылка скопирована'); }
          catch { H.toast('Скопируйте вручную'); }
        };
      });
      b.querySelectorAll('[data-new]').forEach(el => el.onclick = async () => {
        try { await api.shareCreate(boardId, el.dataset.new, 0); draw(); }
        catch (e) { draw(err(e)); }
      });
      b.querySelectorAll('[data-revoke]').forEach(el => el.onclick = async () => {
        try { await api.shareRevoke(el.dataset.revoke); draw('Ссылка отозвана'); }
        catch (e) { draw(err(e)); }
      });
    });
  };
  draw();
}

/* ---------- сохранение серверной доски ---------- */
// Отдельная очередь: сохранение в сеть медленнее локального и может конфликтовать.
let pushT = null, pushing = false, pendingDoc = null;

let pendingPrev = null;
// Слепок состояния на момент последней успешной отправки. Нужен, чтобы к правке
// приложить короткую фразу «что поменялось»: сервер документ не разбирает и сам
// такую фразу составить не может. Храним слепок, а не копию документа целиком —
// вторая копия доски в памяти ради подписи к строчке истории того не стоит.
let baseline = null;
export function setBaseline(fp) { baseline = fp || null; }
export function hasPending() { return !!pendingDoc || pushing; }
export function schedulePush(getDoc, onState, getPreview) {
  if (!CLOUD.board) return;
  pendingDoc = getDoc;
  pendingPrev = getPreview || null;
  clearTimeout(pushT);
  pushT = setTimeout(() => pushNow(onState), 900);
}

export async function pushNow(onState) {
  if (!CLOUD.board || !pendingDoc || pushing) return;
  pushing = true;
  const doc = pendingDoc();
  // Превью считается ровно здесь: оно нужно только серверу для карточки в списке
  // и не должно попадать в сам документ доски.
  let prev; try { prev = pendingPrev ? pendingPrev() : undefined; } catch { prev = undefined; }
  let summary = null;
  try { summary = H.summarize ? H.summarize(baseline, doc) : null; } catch { summary = null; }
  pendingDoc = null;
  try {
    const r = await api.boardPut(CLOUD.board.id, doc, CLOUD.board.version, prev, summary);
    CLOUD.board.version = r.version;
    try { baseline = H.fingerprint ? H.fingerprint(doc) : null; } catch { baseline = null; }
    if (onState) onState({ok: true, version: r.version});
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      // На сервере более новая версия. Молча перезаписывать нельзя — это стёрло бы
      // чужую работу. Показываем выбор: взять серверную или отправить свою поверх.
      if (onState) onState({conflict: true, server: e.body});
    } else if (onState) onState({error: err(e)});
  } finally {
    pushing = false;
  }
}

export function boundToServer() { return !!CLOUD.board; }
export function bindBoard(info) { CLOUD.board = info; }
export function unbindBoard() { CLOUD.board = null; clearTimeout(pushT); pendingDoc = null; pendingPrev = null; baseline = null; }
