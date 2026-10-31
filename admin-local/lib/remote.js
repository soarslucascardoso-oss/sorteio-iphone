// Cliente do back-end hospedado. A chave administrativa só existe neste processo (nunca vai ao navegador).
export function createRemote({ baseUrl, apiKey, timeoutMs = 20_000 }) {
  const u = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw new Error('REMOTE_URL deve usar HTTPS (http só é aceito para localhost em testes).');
  const root = u.origin;
  return async function request(method, path, { query, body, actor, raw = false } = {}) {
    const url = new URL('/internal/admin' + path, root);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${apiKey}`, 'x-admin-actor': actor || 'admin', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      });
    } catch {
      return { status: 502, json: { ok: false, code: 'REMOTE_UNAVAILABLE', message: 'Não foi possível conectar ao serviço hospedado. Verifique a internet e o REMOTE_URL.' } };
    }
    if (raw && res.ok) return { status: res.status, text: await res.text(), contentType: res.headers.get('content-type') };
    if (res.status === 401 || res.status === 429) return { status: 502, json: { ok: false, code: 'REMOTE_AUTH_FAILED', message: 'O serviço hospedado recusou a chave administrativa (ou bloqueou temporariamente). Confira ADMIN_API_KEY / ADMIN_API_KEY_SHA256.' } };
    const json = await res.json().catch(() => ({ ok: false, code: 'BAD_REMOTE', message: 'Resposta inválida do serviço hospedado.' }));
    return { status: res.status, json };
  };
}
