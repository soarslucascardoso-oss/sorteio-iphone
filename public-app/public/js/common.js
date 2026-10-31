// Utilidades compartilhadas (sem innerHTML: todo conteúdo dinâmico entra via textContent).
export const fmtDateTime = (iso) => iso ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'America/Sao_Paulo' }).format(new Date(iso)) : 'A definir';
export const fmtDate = (iso) => iso ? new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeZone: 'America/Sao_Paulo' }).format(new Date(iso)) : 'A definir';

export async function loadConfig() {
  const r = await fetch('/api/public/config', { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error('config');
  return r.json();
}

export function bind(cfg) {
  const map = {
    title: cfg.title, prizeName: cfg.prizeName, organizerName: cfg.organizerName || '[organizador a definir]',
    contactEmail: cfg.contactEmail || '[e-mail de contato a definir]',
    startAt: fmtDateTime(cfg.startAt), endAt: fmtDateTime(cfg.endAt), resultAt: fmtDateTime(cfg.resultAt),
  };
  document.querySelectorAll('[data-bind]').forEach((el) => {
    const v = map[el.dataset.bind];
    if (v !== undefined) el.textContent = v;
  });
  document.querySelectorAll('[data-bind-href]').forEach((el) => {
    if (cfg.contactEmail) el.setAttribute('href', 'mailto:' + cfg.contactEmail);
  });
  document.title = `${document.body.dataset.page ? document.body.dataset.page + ' · ' : ''}${cfg.title}`;
}
