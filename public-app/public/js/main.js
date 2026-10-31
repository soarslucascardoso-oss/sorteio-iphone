import { loadConfig, bind, fmtDateTime } from './common.js';

const $ = (id) => document.getElementById(id);
const dlg = $('signup');
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}'’.\- ]*$/u;
let cfg = null;
let submitting = false;
let turnstileToken = '';

function labelForState(state) {
  return { open: '', not_started: 'As inscrições ainda não foram abertas.', ended: 'As inscrições foram encerradas.', closed: 'As inscrições foram encerradas.' }[state] || '';
}

async function init() {
  try {
    cfg = await loadConfig();
  } catch {
    $('stateNote').textContent = 'Não foi possível carregar o sorteio. Atualize a página.';
    return;
  }
  bind(cfg);
  $('title').textContent = cfg.title;
  $('description').textContent = cfg.description;
  $('endAt').textContent = fmtDateTime(cfg.endAt);
  $('resultAt').textContent = fmtDateTime(cfg.resultAt);
  const open = cfg.state === 'open';
  $('openForm').disabled = !open;
  $('stateNote').textContent = labelForState(cfg.state);
  if (cfg.resultPublished) { $('stateNote').textContent = 'O resultado já foi divulgado. Veja na página de resultado.'; }
  if (open && cfg.turnstileSiteKey) loadTurnstile(cfg.turnstileSiteKey);
}

function loadTurnstile(siteKey) {
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async = true;
  s.onload = () => window.turnstile.render('#turnstile', { sitekey: siteKey, callback: (t) => { turnstileToken = t; } });
  document.head.appendChild(s);
}

function setErr(id, msg) {
  $(id + 'Err').textContent = msg || '';
  const input = $(id);
  if (input) input.setAttribute('aria-invalid', msg ? 'true' : 'false');
}

function validate() {
  const name = $('name').value.normalize('NFC').replace(/\s+/g, ' ').trim();
  const email = $('email').value.trim();
  const errs = {};
  if (name.length < 5 || name.length > 120 || !NAME_RE.test(name) || name.split(' ').length < 2) errs.name = 'Informe seu nome completo (nome e sobrenome), apenas com letras.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) errs.email = 'Informe um e-mail válido.';
  if (!$('consent').checked) errs.consent = 'É necessário concordar para participar.';
  setErr('name', errs.name); setErr('email', errs.email); setErr('consent', errs.consent);
  return { ok: !Object.keys(errs).length, name, email, errs };
}

$('openForm').addEventListener('click', async () => {
  $('formView').hidden = false; $('doneView').hidden = true; $('formAlert').hidden = true;
  try { cfg = await loadConfig(); } catch { /* mantém o token anterior */ }
  dlg.showModal();
  $('name').focus();
});
$('closeDlg').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (submitting) return; // evita envios repetidos
  const v = validate();
  if (!v.ok) { (v.errs.name ? $('name') : v.errs.email ? $('email') : $('consent')).focus(); return; }
  if (cfg.turnstileSiteKey && !turnstileToken) { showAlert('Conclua a verificação anti-robô.'); return; }
  submitting = true;
  const btn = $('submit');
  btn.disabled = true; btn.textContent = 'ENVIANDO…';
  $('formAlert').hidden = true;
  try {
    const res = await fetch('/api/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ name: v.name, email: v.email, consent: true, website: $('website').value, formToken: cfg.formToken, turnstileToken }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 201 && data.ok) {
      $('doneMsg').textContent = data.message;
      $('doneNum').textContent = data.entryNumber;
      $('formView').hidden = true; $('doneView').hidden = false;
      $('form').reset();
      return;
    }
    if (res.status === 422 && data.errors) {
      setErr('name', data.errors.name); setErr('email', data.errors.email); setErr('consent', data.errors.consent);
    } else if (res.status === 409) {
      setErr('email', data.message); $('email').focus();
    } else if (res.status === 429) {
      showAlert('Muitas tentativas. Aguarde alguns minutos e tente novamente.');
    } else {
      showAlert(data.message || 'Não foi possível concluir a inscrição. Tente novamente.');
      if (data.code === 'FORM_EXPIRED') { try { cfg = await loadConfig(); } catch { /* ignora */ } }
    }
  } catch {
    showAlert('Sem conexão com o servidor. Verifique sua internet e tente novamente.');
  } finally {
    submitting = false; btn.disabled = false; btn.textContent = 'PARTICIPAR DO SORTEIO';
    if (window.turnstile && cfg.turnstileSiteKey) { turnstileToken = ''; try { window.turnstile.reset(); } catch { /* ignora */ } }
  }
});

function showAlert(msg) { const a = $('formAlert'); a.textContent = msg; a.hidden = false; }
init();
