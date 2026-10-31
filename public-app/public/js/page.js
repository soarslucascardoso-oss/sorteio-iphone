import { loadConfig, bind, fmtDate, fmtDateTime } from './common.js';

try {
  const cfg = await loadConfig();
  bind(cfg);
  const rules = document.getElementById('rulesText');
  if (rules) {
    rules.replaceChildren(...cfg.rulesText.split(/\n{2,}/).map((t) => Object.assign(document.createElement('p'), { textContent: t.trim() })));
    const auth = document.getElementById('authLine');
    if (auth && cfg.authorizationNumber) { auth.textContent = `Autorização/registro do sorteio: ${cfg.authorizationNumber}`; auth.hidden = false; }
  }
  const box = document.getElementById('resultBox');
  if (box) {
    const r = await (await fetch('/api/public/result')).json();
    const msg = document.getElementById('resultMsg');
    if (r.published) {
      box.hidden = false;
      document.getElementById('winnerMask').textContent = r.winner.maskedName;
      document.getElementById('winnerNum').textContent = r.winner.entryNumber;
      document.getElementById('drawnAt').textContent = fmtDateTime(r.drawnAt);
      document.getElementById('eligible').textContent = String(r.eligibleCount);
      msg.hidden = true;
    } else {
      msg.textContent = `O resultado ainda não foi divulgado. Data prevista: ${fmtDate(cfg.resultAt)}.`;
    }
  }
} catch {
  const el = document.getElementById('loadError');
  if (el) el.hidden = false;
}
