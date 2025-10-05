# CaraNoLivro

Projeto exemplo simples que implementa uma API REST e um frontend estático para simular posts e usuários (como uma mini rede social chamada "CaraNoLivro").

Pré-requisitos

- Node.js 12+ instalado

Como rodar

No PowerShell:

```powershell
cd "c:\Users\gabri\OneDrive\Documentos\VISUAL STUDIO CODE PASTS\projetoApiCaraNoLivro\CaraNoLivro"
npm install --no-audit --no-fund; npm start
```

Endpoints

- GET /api/users - lista usuários
- POST /api/users - cria usuário: { name }
- GET /api/posts - lista posts
- POST /api/posts - cria post: { userId, content }

Notas

- Armazenamento em memória: reiniciar o servidor zera dados.
- Projeto educacional; não usar em produção sem melhorias (validação, autenticação, persistência).
 - Persistência simples: dados agora são salvos em `data/users.json` e `data/posts.json` e serão mantidos entre reinícios.
 - Faça backup dos arquivos em `data/` se quiser preservar entre máquinas.
 - Autenticação simples: existe o endpoint `POST /api/login` que aceita `{ userId }` e retorna `{ token }`. O frontend usa esse token (Bearer) para criar/editar/excluir posts.
 - Observação: tokens são armazenados apenas em memória no servidor (perdem-se após reiniciar). Em produção, usar JWT ou session store.
 - Exclusão de usuário: apenas o próprio usuário autenticado pode excluir sua conta (rota `DELETE /api/users/:id` exige Authorization: Bearer <token> do mesmo usuário). Isso evita que outros usuários deletem contas alheias.
 
Arquivos e comportamento novo
----------------------------
- `data/pendingDeletes.json`: armazena temporariamente entradas de exclusão (undo). Quando um post ou usuário é excluído, o servidor retorna um `undoToken` e guarda a operação por um curto período (janela de desfazer). Se o undo não for acionado dentro desse período, a exclusão é considerada permanente.
- `PENDING_TTL_MS` (variável de ambiente, opcional): controla o tempo em milissegundos da janela de undo. Padrão: 10000 (10s).

Endpoint de desfazer
--------------------
- POST `/api/undo` com body `{ "undoToken": "undo_xxx" }` restaura a entidade (usuário ou post) enquanto o token estiver válido.

Executando os testes rápidos (smoke test)
--------------------------------------
Há um script simples `smoke-test.js` que executa um fluxo básico: cria um usuário, efetua login, cria um post, deleta o post e tenta desfazer a exclusão.

No PowerShell, rode:

```powershell
node smoke-test.js
```

Notas de segurança e próximos passos
----------------------------------
- Tokens de autenticação atuais são simples (armazenados em memória). Para persistência de sessões entre reinícios ou maior segurança, considere usar JWT com chave secreta ou um session store (Redis, banco, etc).
- Ative HTTPS e proteja endpoints sensíveis em produção.
- Considere adicionar validação adicional e rate limiting para proteger contra abusos.
