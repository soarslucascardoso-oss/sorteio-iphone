// Painel local. Todo texto vindo do servidor entra via textContent (sem innerHTML).
const $ = (s, r = document) => r.querySelector(s);
let csrf = '';
let user = '';
let tab = 'overview';
const fmt = (iso) => iso ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(iso)) : '—';

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/admin/api' + path, {
    method, credentials: 'same-origin',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/login') { showLogin(); throw new Error('Sessão expirada.'); }
  if (!r.ok) { const e = new Error(data.message || 'Erro'); e.data = data; throw e; }
  return data;
}

function toast(msg, bad = false) {
  const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (bad ? ' bad' : ''); t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 5000);
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

function showLogin() { $('#app').hidden = true; $('#login').hidden = false; csrf = ''; $('#p').value = ''; }
function showApp() { $('#login').hidden = true; $('#app').hidden = false; $('#who').textContent = user; render(); }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#loginErr').textContent = '';
  try {
    const d = await api('/login', { method: 'POST', body: { username: $('#u').value, password: $('#p').value } });
    csrf = d.csrfToken; user = d.user; showApp();
  } catch (err) { $('#loginErr').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { try { await api('/logout', { method: 'POST' }); } catch { /* ignora */ } showLogin(); });
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]'); if (!b) return;
  tab = b.dataset.tab; document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b)); render();
});

const views = { overview, people, draw, settings, audit };
function render() { $('#view').replaceChildren(h('p', { class: 'muted' }, 'Carregando…')); views[tab]().catch((e) => $('#view').replaceChildren(h('p', { class: 'err' }, e.message))); }

const stateLabel = (s) => s.registrations_closed ? 'closed' : (s.end_at && new Date() > new Date(s.end_at)) ? 'ended' : (s.start_at && new Date() < new Date(s.start_at)) ? 'pending' : 'open';
const stateText = { open: 'Inscrições abertas', closed: 'Inscrições encerradas', ended: 'Prazo encerrado', pending: 'Ainda não iniciou' };

async function overview() {
  const d = await api('/stats');
  const st = stateLabel(d.settings);
  const max = Math.max(1, ...d.perDay.map((x) => x.n));
  const view = $('#view');
  view.replaceChildren(
    h('h2', {}, 'Visão geral'),
    d.settings.rules_text.includes('[A DEFINIR') ? h('div', { class: 'hint' }, 'O regulamento ainda contém marcações "[A DEFINIR…]". Revise em Configurações antes de divulgar o site.') : null,
    h('div', { class: 'cards' },
      h('div', { class: 'panel stat' }, h('b', {}, d.total), h('span', {}, 'Participantes inscritos')),
      h('div', { class: 'panel stat' }, h('b', {}, d.last24h), h('span', {}, 'Nas últimas 24 h')),
      h('div', { class: 'panel stat' }, h('b', {}, h('span', { class: 'pill ' + (st === 'open' ? 'open' : 'closed') }, stateText[st])), h('span', {}, 'Situação')),
      h('div', { class: 'panel stat' }, h('b', {}, d.activeDraw ? 'Realizado' : 'Pendente'), h('span', {}, 'Sorteio'))),
    h('div', { class: 'panel' }, h('h3', {}, 'Inscrições por dia (14 dias)'),
      d.perDay.length ? h('div', { class: 'chart' }, d.perDay.map((x) => { const bar = h('div', { title: `${x.day}: ${x.n}` }, h('small', {}, x.n)); bar.style.height = Math.round((x.n / max) * 100) + '%'; return bar; })) : h('p', { class: 'muted' }, 'Sem inscrições ainda.')),
  );
}

async function people() {
  const state = people.state || (people.state = { search: '', from: '', to: '', page: 1 });
  const q = new URLSearchParams({ page: state.page, pageSize: 20 });
  if (state.search) q.set('search', state.search);
  if (state.from) q.set('from', new Date(state.from).toISOString());
  if (state.to) q.set('to', new Date(state.to + 'T23:59:59.999').toISOString());
  const d = await api('/entries?' + q);
  const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  const exp = new URLSearchParams(); ['search'].forEach((k) => state[k] && exp.set(k, state[k]));
  if (state.from) exp.set('from', new Date(state.from).toISOString()); if (state.to) exp.set('to', new Date(state.to + 'T23:59:59.999').toISOString());
  const form = h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); state.search = $('#fs').value.trim(); state.from = $('#ff').value; state.to = $('#ft').value; state.page = 1; render(); } },
    h('div', {}, h('label', { for: 'fs' }, 'Buscar por nome ou e-mail'), h('input', { id: 'fs', value: state.search })),
    h('div', {}, h('label', { for: 'ff' }, 'De'), h('input', { id: 'ff', type: 'date', value: state.from })),
    h('div', {}, h('label', { for: 'ft' }, 'Até'), h('input', { id: 'ft', type: 'date', value: state.to })),
    h('button', { class: 'btn primary', type: 'submit' }, 'Filtrar'),
    h('a', { class: 'btn', href: '/admin/api/export.csv?' + exp, download: '' }, 'Exportar CSV'));
  $('#view').replaceChildren(
    h('h2', {}, `Participantes (${d.total})`), h('div', { class: 'panel' }, form),
    h('div', { class: 'panel scroll' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Nº', 'Nome', 'E-mail', 'Inscrito em'].map((x) => h('th', {}, x)))),
      h('tbody', {}, d.items.length ? d.items.map((x) => h('tr', {}, h('td', {}, x.number), h('td', {}, x.name, x.isWinner ? h('span', { class: 'pill win' }, ' ganhador') : null), h('td', {}, x.email), h('td', {}, fmt(x.createdAt)))) : h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'Nenhum participante encontrado.')))),
      h('div', { class: 'pager' }, h('button', { class: 'btn', disabled: state.page <= 1, onclick: () => { state.page--; render(); } }, '‹ Anterior'), h('span', { class: 'muted' }, `Página ${d.page} de ${pages}`), h('button', { class: 'btn', disabled: state.page >= pages, onclick: () => { state.page++; render(); } }, 'Próxima ›'))));
}

async function draw() {
  const [st, dr] = await Promise.all([api('/stats'), api('/draws')]);
  const s = st.settings; const active = st.activeDraw; const stt = stateLabel(s);
  const act = (path, body, ok) => guard(async () => { await api(path, { method: 'POST', body: body || {} }); toast(ok); render(); });
  $('#view').replaceChildren(
    h('h2', {}, 'Sorteio'),
    h('div', { class: 'panel' }, h('p', {}, h('span', { class: 'pill ' + (stt === 'open' ? 'open' : 'closed') }, stateText[stt]), ` · ${st.total} inscrições`),
      h('div', { class: 'row' },
        s.registrations_closed ? h('button', { class: 'btn', disabled: !!active, onclick: act('/registrations/open', null, 'Inscrições reabertas.') }, 'Reabrir inscrições') : h('button', { class: 'btn danger', onclick: () => { if (confirm('Encerrar novas inscrições agora?')) act('/registrations/close', null, 'Inscrições encerradas.')(); } }, 'Encerrar inscrições'),
        h('button', { class: 'btn primary', disabled: stt === 'open' || stt === 'pending', onclick: () => openDrawDialog(!!active) }, active ? 'Sortear novamente…' : 'Executar sorteio…')),
      stt === 'open' || stt === 'pending' ? h('p', { class: 'muted' }, 'Encerre as inscrições para liberar o sorteio.') : null),
    active ? h('div', { class: 'winner' }, h('p', { class: 'muted' }, 'Ganhador(a) — sorteio ' + fmt(active.drawnAt) + ` entre ${active.eligibleCount} inscrições`), h('h2', {}, active.name), h('p', {}, active.email),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: act('/result/publish', { published: !s.result_published }, s.result_published ? 'Resultado ocultado.' : 'Resultado publicado.') }, s.result_published ? 'Ocultar resultado do site' : 'Publicar resultado no site'),
        h('span', { class: 'muted' }, s.result_published ? 'Visível no site (nome mascarado).' : 'Ainda não aparece no site público.'))) : null,
    h('div', { class: 'panel scroll' }, h('h3', {}, 'Histórico de sorteios'), h('table', {},
      h('thead', {}, h('tr', {}, ['Quando', 'Nº', 'Ganhador', 'Elegíveis', 'Executado por', 'Situação'].map((x) => h('th', {}, x)))),
      h('tbody', {}, dr.items.length ? dr.items.map((x) => h('tr', {}, h('td', {}, fmt(x.drawnAt)), h('td', {}, x.entryNumber), h('td', {}, x.name, h('br'), h('span', { class: 'muted' }, x.email)), h('td', {}, x.eligibleCount), h('td', {}, x.actor), h('td', {}, x.annulledAt ? `Anulado em ${fmt(x.annulledAt)}: ${x.annulledReason}` : 'Ativo'))) : h('tr', {}, h('td', { colspan: 6, class: 'muted' }, 'Nenhum sorteio realizado.'))))));
}

function openDrawDialog(redo) {
  const dlg = h('dialog', {});
  const phrase = h('input', { id: 'dc', autocomplete: 'off', placeholder: 'Digite SORTEAR' });
  const reason = h('textarea', { id: 'dr', placeholder: 'Justificativa (obrigatória para novo sorteio, mín. 10 caracteres)' });
  const go = h('button', { class: 'btn primary', disabled: true }, 'Confirmar e sortear');
  const msg = h('p', { class: 'err' });
  const check = () => { go.disabled = phrase.value !== 'SORTEAR' || (redo && reason.value.trim().length < 10); };
  phrase.addEventListener('input', check); reason.addEventListener('input', check);
  go.addEventListener('click', guard(async () => {
    go.disabled = true; // impede clique duplo
    try { const d = await api('/draw', { method: 'POST', body: { confirm: phrase.value, reason: redo ? reason.value : undefined } }); dlg.close(); dlg.remove(); toast(`Ganhador: ${d.winner.name}`); render(); }
    catch (e) { msg.textContent = e.message; check(); }
  }));
  dlg.append(h('h3', {}, redo ? 'Novo sorteio' : 'Executar sorteio'), h('p', { class: 'muted' }, 'A ação é registrada no histórico e executada no servidor. Apenas inscrições válidas no período são consideradas.'),
    redo ? h('p', { class: 'hint' }, 'Já existe um ganhador. O resultado anterior será anulado (e o ganhador anterior não concorre de novo).') : null,
    phrase, redo ? reason : null, msg, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { dlg.close(); dlg.remove(); } }, 'Cancelar'), go));
  document.body.append(dlg); dlg.showModal(); phrase.focus();
}

const toLocalInput = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
async function settings() {
  const { settings: s } = await api('/settings');
  const f = (id, label, el) => h('div', {}, h('label', { for: id }, label), el);
  const inputs = {
    title: h('input', { id: 'title', value: s.title, maxlength: 120 }), prize_name: h('input', { id: 'prize_name', value: s.prize_name, maxlength: 80 }),
    description: h('textarea', { id: 'description' }, s.description), start_at: h('input', { id: 'start_at', type: 'datetime-local', value: toLocalInput(s.start_at) }),
    end_at: h('input', { id: 'end_at', type: 'datetime-local', value: toLocalInput(s.end_at) }), result_at: h('input', { id: 'result_at', type: 'datetime-local', value: toLocalInput(s.result_at) }),
    organizer_name: h('input', { id: 'organizer_name', value: s.organizer_name, maxlength: 120 }), contact_email: h('input', { id: 'contact_email', type: 'email', value: s.contact_email }),
    authorization_number: h('input', { id: 'authorization_number', value: s.authorization_number, maxlength: 120 }), rules_text: h('textarea', { id: 'rules_text' }, s.rules_text),
  };
  inputs.rules_text.style.minHeight = '320px';
  const submit = guard(async (e) => {
    e.preventDefault();
    const body = {};
    for (const [k, el] of Object.entries(inputs)) body[k] = el.type === 'datetime-local' ? (el.value ? new Date(el.value).toISOString() : null) : el.value;
    await api('/settings', { method: 'PUT', body }); toast('Configurações salvas.'); render();
  });
  $('#view').replaceChildren(h('h2', {}, 'Configurações do sorteio'),
    h('div', { class: 'hint' }, 'Datas em horário local deste computador. O texto abaixo aparece no site público. Informe o promotor e o contato (usados na Política de Privacidade) e confirme com um profissional se o sorteio exige autorização.'),
    h('form', { class: 'panel', onsubmit: submit },
      f('title', 'Título', inputs.title), f('prize_name', 'Prêmio', inputs.prize_name), f('description', 'Descrição', inputs.description),
      h('div', { class: 'row' }, f('start_at', 'Início das inscrições', inputs.start_at), f('end_at', 'Encerramento das inscrições', inputs.end_at), f('result_at', 'Data prevista do resultado', inputs.result_at)),
      h('div', { class: 'row' }, f('organizer_name', 'Promotor / controlador dos dados', inputs.organizer_name), f('contact_email', 'E-mail de contato (LGPD)', inputs.contact_email), f('authorization_number', 'Nº de autorização/registro (se houver)', inputs.authorization_number)),
      f('rules_text', 'Regulamento (separe parágrafos com linha em branco)', inputs.rules_text), h('p', {}), h('button', { class: 'btn primary', type: 'submit' }, 'Salvar')));
}

async function audit() {
  const page = audit.page || 1;
  const d = await api('/audit?page=' + page); const pages = Math.max(1, Math.ceil(d.total / d.pageSize));
  const names = { draw: 'Sorteio realizado', draw_redo: 'Novo sorteio', export_csv: 'Exportação CSV', settings_update: 'Configurações alteradas', registrations_close: 'Inscrições encerradas', registrations_open: 'Inscrições reabertas', result_publish: 'Resultado publicado', result_unpublish: 'Resultado ocultado' };
  $('#view').replaceChildren(h('h2', {}, 'Histórico de ações administrativas'),
    h('div', { class: 'panel scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Quando', 'Quem', 'Ação', 'Detalhes'].map((x) => h('th', {}, x)))),
      h('tbody', {}, d.items.length ? d.items.map((x) => h('tr', {}, h('td', {}, fmt(x.at)), h('td', {}, x.actor), h('td', {}, names[x.action] || x.action), h('td', { class: 'muted' }, Object.keys(x.details || {}).length ? JSON.stringify(x.details) : ''))) : h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'Sem registros.')))),
      h('div', { class: 'pager' }, h('button', { class: 'btn', disabled: page <= 1, onclick: () => { audit.page = page - 1; render(); } }, '‹'), h('span', { class: 'muted' }, `Página ${page} de ${pages}`), h('button', { class: 'btn', disabled: page >= pages, onclick: () => { audit.page = page + 1; render(); } }, '›'))));
}

(async () => {
  try { const s = await api('/session'); if (s.authenticated) { csrf = s.csrfToken; user = s.user; showApp(); } else showLogin(); } catch { showLogin(); }
})();
