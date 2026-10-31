# Sorteio de um iPhone 18 Pro Max — site público + painel local

Duas aplicações **separadas**:

| Pasta | O que é | Onde roda |
|---|---|---|
| `public-app/` | Site público, API de inscrições, sorteio e banco de dados | **Hospedado na internet** (funciona com seu computador desligado) |
| `admin-local/` | Painel administrativo (`http://localhost:3000/admin`) | **Somente no seu computador** (escuta apenas em `127.0.0.1`) |

```
Visitante ──HTTPS──► public-app (hospedado) ──► PostgreSQL (hospedado)
                          ▲
Você ► painel local ──HTTPS + chave secreta──┘   (a chave nunca vai ao navegador)
```

- Inscrições, sorteio e resultado vivem no serviço hospedado. O painel local é só uma interface autenticada.
- O sorteio é feito no servidor (`crypto.randomInt`, dentro de uma transação), nunca no navegador.
- Este README descreve o que foi **construído e testado**. O site **ainda não está publicado**: a publicação depende de contas e configurações suas (veja a seção 7).

---

## 1. Requisitos

- Node.js 20.12 ou superior (recomendado 22) — <https://nodejs.org>
- Para produção: conta em um host Node (exemplo documentado: **Render**) e um PostgreSQL gerenciado (exemplo: **Neon**).

## 2. Instalar dependências

```bash
cd public-app && npm install
cd ../admin-local && npm install
```

## 3. Rodar o site público em desenvolvimento

```bash
cd public-app
cp .env.example .env      # opcional em desenvolvimento
npm run dev               # http://localhost:8080
```

Sem `DATABASE_URL`, usa um Postgres embarcado (PGlite) salvo em `public-app/data/pglite`, então os dados persistem entre reinicializações. O SQL é o mesmo do PostgreSQL de produção.

Para a inscrição funcionar localmente o formulário exige ~3 s desde o carregamento da página (anti-robô). Isso é configurável em `MIN_FORM_SECONDS`.

## 4. Rodar o painel administrativo local

### 4.1 Configurar credenciais (uma vez)

```bash
cd admin-local
npm run setup
```

O assistente pergunta a URL do serviço hospedado, o usuário e a senha (mín. 12 caracteres) e cria `admin-local/.env` (permissão 600) com:

- `ADMIN_PASSWORD_HASH`: senha com hash **scrypt** (a senha em si não é gravada);
- `ADMIN_API_KEY`: chave aleatória de 256 bits usada pelo painel para falar com o serviço hospedado;
- e imprime `ADMIN_API_KEY_SHA256=...` — **cadastre este valor no serviço hospedado** (passo 6). No servidor fica só o hash da chave.

Para testar tudo na sua máquina antes de publicar, use `http://localhost:8080` como URL e rode o site público com a variável `ADMIN_API_KEY_SHA256` preenchida (em `public-app/.env`).

### 4.2 Iniciar

```bash
npm start      # http://localhost:3000/admin
```

Recursos: total de inscritos, lista com busca e paginação, filtro por período, exportação CSV, edição de título/descrição/datas/regulamento/promotor, encerrar/reabrir inscrições, executar sorteio (confirmação digitando `SORTEAR`; novo sorteio exige justificativa), publicar/ocultar o resultado no site e histórico de ações.

### 4.3 Como o painel está protegido

- Escuta só em `127.0.0.1` (não é possível mudar por configuração) e recusa cabeçalhos `Host` que não sejam `localhost`/`127.0.0.1` (proteção contra DNS rebinding).
- Login obrigatório, senha com hash scrypt, cookie `HttpOnly` + `SameSite=Strict`, sessão com expiração por inatividade (30 min) e absoluta (8 h), botão **Sair**.
- Bloqueio após 5 tentativas erradas (15 min), token CSRF em toda ação que altera dados, verificação de `Origin`.
- A chave do serviço hospedado fica só no processo local.

## 5. Banco de dados e migrações

- Esquema em `public-app/server/migrations/*.sql`. As migrações rodam **automaticamente** ao iniciar o servidor (e manualmente com `npm run migrate`).
- E-mail único garantido por índice único no banco (`entries_email_unique`). No máximo um sorteio ativo é garantido por índice parcial (`draws_one_active`).
- Tabelas: `settings`, `entries`, `draws`, `audit_log` e `rate_limits` (contadores temporários; chaves HMAC, sem IP em texto puro).

## 6. Testes

```bash
cd public-app  && npm test     # API pública, validação, duplicidade, persistência, sorteio, backup/restauração
cd admin-local && npm test     # login, bloqueio, sessão/CSRF, fluxo completo via painel, loopback
```

Para rodar os testes do `public-app` contra um PostgreSQL real (em vez do embarcado), defina `TEST_DATABASE_URL` apontando para um banco **descartável** (o esquema `public` é apagado a cada teste).

O teste do painel importa o back-end de `../public-app`; ele roda no monorepo (as duas pastas lado a lado).

## 7. Publicar o site público (passo a passo — depende de você)

### 7.1 Banco de dados (Neon, exemplo)
1. Crie uma conta em <https://neon.tech> e um projeto (região mais próxima; ex.: São Paulo, se disponível).
2. Copie a *connection string* (`postgresql://...sslmode=require`). Ela é o seu `DATABASE_URL`.

### 7.2 Hospedagem (Render, exemplo)
1. Suba **somente** o conteúdo necessário para um repositório **privado** no GitHub. Recomendado: coloque `admin-local/` em **outro** repositório (ou não o versione). O arquivo `.env` nunca deve ir ao Git (já está no `.gitignore`).
2. No Render: *New → Blueprint* e aponte para o repositório (usa o `render.yaml`, com `rootDir: public-app`). Ou crie um *Web Service* manualmente: Root Directory `public-app`, Build `npm ci`, Start `npm start`, Health Check `/healthz`.
3. Defina as variáveis de ambiente:
   - `DATABASE_URL` → string do Neon
   - `ADMIN_API_KEY_SHA256` → valor impresso por `npm run setup`
   - `NODE_ENV=production`, `TRUST_PROXY=1`, `NODE_VERSION=22`
   - `FORM_SECRET` → o blueprint gera; se manual, use 64 caracteres aleatórios.
4. Faça o deploy. O Render fornece HTTPS e um endereço `https://NOME.onrender.com`.

### 7.3 Link público real
- O endereço `https://NOME.onrender.com` já é um link público real após o deploy.
- Para um domínio próprio (ex.: `meusorteio.com.br`): registre o domínio (Registro.br ou outro) e, no Render, *Settings → Custom Domains*, siga as instruções de DNS (CNAME/A). O HTTPS é emitido automaticamente.
- **Nenhum domínio foi criado ou configurado por este projeto.**

### 7.4 Conectar o painel local
Rode `npm run setup` em `admin-local` com a URL final (ou edite `REMOTE_URL` no `.env`), garanta que o `ADMIN_API_KEY_SHA256` correspondente está no servidor e inicie `npm start`.

### 7.5 Conferência pós-publicação (faça você mesmo)
- Abra o link no celular e no computador, inscreva-se, confirme no painel local.
- `https://SEU-LINK/admin` deve responder **404**.
- `https://SEU-LINK/internal/admin/stats` deve responder **401** sem a chave.
- Desligue seu computador e inscreva-se de outro aparelho: deve funcionar.

### 7.6 Observações honestas sobre o plano gratuito
O plano gratuito do Render hiberna após alguns minutos sem acesso; o primeiro acesso depois disso pode levar cerca de um minuto. O site volta a funcionar sozinho (sem depender do seu computador), mas, para um sorteio divulgado em massa, prefira um plano que não hiberne.

## 8. Garantir que o painel não está exposto

- O painel **não faz parte** de `public-app` (o artefato publicado). O site público responde 404 em `/admin`.
- Nunca use túneis (ngrok, Cloudflare Tunnel etc.) nem redirecionamento de portas para a porta 3000. Não abra portas no roteador.
- Verificação: de outro aparelho na mesma rede, `http://IP-DO-SEU-PC:3000/admin` deve **não conectar**.
- **Ponto de atenção:** o serviço hospedado precisa receber chamadas do painel pela internet, então a rota `/internal/admin/*` existe no servidor público. Ela só responde com a chave secreta de 256 bits (comparação em tempo constante, limite de tentativas e nenhum dado sem a chave). Se a chave vazar, rode `npm run setup -- --force` e atualize `ADMIN_API_KEY_SHA256`. Para desligar a API por completo, remova `ADMIN_API_KEY_SHA256` do servidor (ela passa a responder 404).

## 9. Backups e recuperação

1. **Do provedor:** ative/verifique os backups automáticos do banco (no Neon, o histórico de restauração varia conforme o plano).
2. **Lógico (JSON), na sua máquina:** crie `public-app/.env` com o `DATABASE_URL` de produção e rode
   ```bash
   cd public-app && npm run backup      # gera backups/backup-AAAA-MM-DD....json (permissão 600)
   ```
   Agende (cron no Linux/macOS, Agendador de Tarefas no Windows). O arquivo contém dados pessoais: guarde em local protegido/criptografado.
3. **Restaurar** em um banco **vazio** (novo projeto Neon, por exemplo):
   ```bash
   DATABASE_URL=postgresql://... npm run restore -- backups/ARQUIVO.json --confirm
   ```
   Depois aponte `DATABASE_URL` do serviço hospedado para o banco restaurado e reinicie.

## 10. Monitoramento

- `GET /healthz` retorna 200 quando o servidor e o banco respondem. O Render usa esse endereço como *health check*. Para alertas, cadastre o link em um monitor externo (UptimeRobot, Better Stack etc.).
- Erros são registrados em JSON sem dados pessoais (apenas rota e código).

## 11. Segurança implementada

SQL parametrizado (sem concatenação); inscrição, encerramento e sorteio serializados por lock transacional na linha de configurações; limitadores de requisição compartilhados pelo PostgreSQL entre instâncias/reinicializações, com identificadores HMAC em vez de IP em texto puro; conteúdo dinâmico sempre via `textContent`; CSP restritiva (sem scripts/estilos inline), `X-Content-Type-Options`, HSTS em produção, `frame-ancestors 'none'`; verificação de `Origin` e `Content-Type: application/json` na inscrição (proteção CSRF); limite de requisições; campo-isca (honeypot) e token assinado com tempo mínimo de preenchimento; Cloudflare Turnstile **opcional, mas recomendado antes de divulgação ampla** (`TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET`, que devem ser configuradas juntas); exportação CSV protegida contra injeção de fórmulas; segredos só em variáveis de ambiente; nenhum participante é enviado ao navegador público; resultado público só com nome mascarado (ex.: `M*** S***`).

## 12. Recomendações adicionais antes de divulgação

- Configure o Cloudflare Turnstile e cadastre as duas variáveis (`TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET`) no serviço hospedado. O servidor recusa a inicialização se apenas uma delas estiver configurada.
- Os limitadores agora usam a tabela `rate_limits` no PostgreSQL: funcionam entre reinicializações e múltiplas instâncias. A chave do cliente é armazenada como HMAC, não como endereço IP em texto puro.
- Inscrição, fechamento/reabertura e sorteio usam o mesmo lock transacional da linha `settings`, impedindo que uma inscrição ultrapasse o fechamento por concorrência.
- Ainda assim, faça teste de carga moderado e monitore erros/limites do provedor antes de uma campanha grande.

## 13. O que depende de você

1. Criar contas (Neon, Render, GitHub) e fazer o deploy (seção 7).
2. Rodar `npm run setup` e cadastrar `ADMIN_API_KEY_SHA256` no servidor.
3. Em **Configurações** do painel: promotor/controlador, e-mail de contato (LGPD), datas, número de autorização (se houver) e **revisar o regulamento** (o texto padrão tem marcação `[A DEFINIR PELO ORGANIZADOR]`). A Política de Privacidade usa promotor e e-mail de contato dessas configurações.
4. **Verificar a legalidade do sorteio no Brasil.** Sorteios com distribuição de prêmios podem exigir autorização prévia do órgão competente (Lei nº 5.768/71 e normas da Secretaria de Prêmios e Apostas do Ministério da Fazenda), conforme o tipo de promoção. Este projeto **não** obtém nem afirma autorização alguma: consulte o órgão ou um advogado e preencha o número de autorização, se houver. Peça também revisão jurídica da Política de Privacidade e do regulamento.
5. Garantir que tem os direitos de uso da foto do iPhone e que o prêmio existe e será entregue. O site traz o aviso de que não é patrocinado nem endossado pela Apple.
6. Domínio próprio (opcional) e um monitor externo (opcional).

## 14. Estrutura

```
public-app/   server/ (app, admin API, sorteio, migrações) · public/ (HTML, CSS, JS, imagem) · scripts/ (backup, restore) · test/
admin-local/  server.js · lib/ (auth, cliente remoto) · public/ (interface) · scripts/setup.js · test/
render.yaml   blueprint do Render (somente public-app)
```
