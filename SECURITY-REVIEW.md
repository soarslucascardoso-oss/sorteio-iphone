# Revisão de segurança — pacote atualizado

Data da revisão: 2026-10-30

## Alterações aplicadas

1. **Concorrência no ciclo de inscrições:** a validação do estado e a gravação da inscrição agora ocorrem na mesma transação, com `SELECT ... FOR UPDATE` na linha `settings`. O fechamento/reabertura e o sorteio usam o mesmo lock, evitando que uma inscrição ultrapasse o encerramento por uma corrida entre requisições.
2. **Rate limit compartilhado:** os limitadores da API pública e da API administrativa agora usam PostgreSQL, em vez de memória do processo. Os contadores sobrevivem a reinicializações e são compartilhados entre instâncias. As chaves persistidas são HMAC-SHA256, não endereços IP em texto puro.
3. **Nova migração:** `002_rate_limits.sql` cria a tabela e o índice para os contadores temporários.
4. **Configuração Turnstile:** o servidor agora recusa uma configuração incompleta: `TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET` precisam estar ambas definidas ou ambas vazias.
5. **Validação de limites de configuração:** `MIN_FORM_SECONDS` e `ENTRIES_RATE_LIMIT` agora são validados na inicialização para evitar valores inválidos ou extremos.
6. **Documentação:** README atualizado com as alterações e a recomendação de ativar Turnstile antes de divulgação ampla.
7. **Testes adicionados:** casos para persistência do rate limit após reinicialização e para inscrição concorrente com encerramento.

## Verificações executadas nesta revisão

- `node --check` em todos os arquivos JavaScript: passou.
- A instalação das dependências com `npm ci` não pôde ser concluída neste ambiente por indisponibilidade/timeout no acesso ao registro npm. Por isso, a suíte automatizada não foi reexecutada nesta revisão.
- Nenhum teste de invasão em produção foi possível, pois o serviço ainda não está publicado.

## Antes do deploy

- Execute `npm ci` e `npm test` em `public-app` e `npm ci` e `npm test` em `admin-local`, em uma máquina com acesso ao registro npm.
- Configure as duas chaves do Cloudflare Turnstile no provedor antes de divulgar o formulário amplamente.
- Confirme `TRUST_PROXY=1` no Render (já previsto no `render.yaml`).
- Use um banco PostgreSQL gerenciado com TLS e credenciais exclusivas para esta aplicação.
- Não versione `.env`, não publique `admin-local/` e não compartilhe `ADMIN_API_KEY` ou `DATABASE_URL`.

Esta revisão melhora controles específicos, mas não constitui certificação nem garantia de segurança absoluta.
