# Architecture Decision Records

Este arquivo registra decisões arquiteturais que afetam limites, dados,
contratos ou operação. Cada ADR descreve o contexto, a decisão e suas
consequências. Decisões substituídas devem ser marcadas como superseded e
referenciar o ADR que as substitui.

## ADR-001 — Monólito modular e limites de dependência

- **Status:** Accepted
- **Data:** 2026-10-10

### Contexto

O desafio exige uma API financeira com entrada HTTP e SQS, persistência
transacional e workers. Separar processos aumentaria o custo operacional sem
ser necessário para cumprir os requisitos.

### Decisão

Manter um monólito modular NestJS, organizado por capacidades `wallet` e
`wager`. Domínio e casos de uso não dependem de HTTP, SQS ou MikroORM; módulos
de composição conectam controllers, workers e adaptadores. Usar Bun, TypeScript
estrito e MikroORM com PostgreSQL, conforme a stack obrigatória e a preferência
do README.

Autenticação fica fora do escopo, como permitido pelo README. Se for adicionada,
deve usar um Identity Provider externo. O ponto de acoplamento HTTP são os
controllers de provedores em `src/modules/wallet/wallet.controller.ts` e
`src/modules/wager/wager.controller.ts`, nos quais um `AuthGuard` pode ser
aplicado sem proteger os health checks nem a entrada interna SQS.

### Consequências

- Um deploy contém API e workers; não há comunicação interna por rede.
- `domain/` permanece livre de dependências de framework e persistência.
- Não há tabelas de usuário, senhas ou autenticação artesanal.

## ADR-002 — Dinheiro exato e ledger append-only

- **Status:** Accepted
- **Data:** 2026-10-10

### Contexto

O saldo é financeiro e precisa permanecer exato em operações, persistência,
eventos e respostas, inclusive sob concorrência.

### Decisão

Representar dinheiro com `Money` imutável, `decimal.js` e strings decimais de
escala fixa nas fronteiras. Persistir montantes em `NUMERIC(18,2)` e moeda em
coluna separada. Wallet, transação, ledger e outbox usam migrations e
constraints PostgreSQL para unicidade, não-negatividade, aritmética e
imutabilidade do ledger. `OPENING` é uma transação interna: saldo positivo
inicial cria wallet, transação e crédito no ledger atomicamente; saldo zero não
cria lançamento.

### Consequências

- Valores monetários não passam por `number`, `float` ou `double`.
- Ajustes de saldo não alteram nem apagam lançamentos existentes; correções
  precisam ser novas movimentações compensatórias.
- PostgreSQL, e não estado em memória, protege invariantes entre instâncias.

## ADR-003 — Idempotência e serialização por wallet

- **Status:** Accepted
- **Data:** 2026-10-10

### Contexto

Provedores podem repetir operações e diferentes instâncias podem disputar o
mesmo saldo. A key isolada em memória ou a ordenação FIFO não protege o estado
financeiro persistido.

### Decisão

Escopar `Idempotency-Key` por `(providerId, idempotencyKey)` e persistir também
unicidade de `(providerId, externalTransactionId)`. Calcular SHA-256 de JSON
canônico dos campos de negócio: `providerId`, `externalTransactionId`,
`playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e a referência
opcional. Excluir headers e metadados de transporte. Payload igual reproduz o
status e o saldo originais; payload diferente conflita.

Em uma transação MikroORM, bloquear a wallet com `PESSIMISTIC_WRITE` antes de
reservar a transação. Aplicar transição no domínio e persistir wallet,
transação, ledger e outbox no mesmo commit. Constraints únicas resolvem corridas
de reserva; constraints financeiras permanecem a última defesa do banco.

### Consequências

- A unidade de serialização é `walletId`; carteiras distintas podem avançar em
  paralelo.
- Um conflito idempotente com hash igual lê o resultado vencedor depois do
  rollback da transação concorrente.
- O `version` da wallet só avança quando o saldo muda.

## ADR-004 — Referências, inbox SQS e retry

- **Status:** Accepted
- **Data:** 2026-10-10

### Contexto

Mensagens são entregues pelo menos uma vez e operações dependentes podem chegar
antes da referência. O processamento não pode confirmar uma mensagem antes de
seu estado durável nem descartar referências ainda ausentes.

### Decisão

HTTP e SQS reutilizam `ProcessWagerUseCase`. O consumidor valida o envelope antes
de criar objetos de domínio e reserva `(consumerName, messageId)` na inbox dentro
da mesma transação PostgreSQL da wallet, transação, ledger e outbox. Só confirma
a mensagem depois do commit. Falhas de negócio são terminais; falhas
transitórias recebem backoff de visibilidade; entradas inválidas ou
permanentes vão para a DLQ. O redrive da fila limita o recebimento a três
tentativas. No encerramento, o consumidor termina o trabalho em andamento e
devolve mensagens ainda não iniciadas.

`WIN` aguarda uma referência opcional; `REFUND` e `ROLLBACK` exigem referência.
Compatibilidade, estado processado, valor e unicidade de reversão são
verificados antes de aplicar o efeito. Referências ausentes ficam
`PENDING_REFERENCE`; o worker reclama a linha com lock e agenda até cinco
consultas totais, com delays de 1, 2, 4 e 8 segundos e teto configurado de 60
segundos. Esgotar as tentativas persiste `WAGER_REFERENCE_NOT_FOUND` e o evento
de rejeição na mesma transação.

### Consequências

- Redelivery após commit encontra a inbox persistida e não repete o efeito.
- Um crash antes do commit deixa inbox e efeito financeiro revertidos juntos.
- O limite de tentativas evita manter referências pendentes indefinidamente.

## ADR-005 — Outbox transacional e publicação SQS

- **Status:** Accepted
- **Data:** 2026-10-10

### Contexto

Publicar diretamente durante uma transação pode expor eventos de alterações
que acabam revertidas; publicar somente depois do commit pode perder eventos se
o processo cair nesse intervalo.

### Decisão

Gravar os eventos exigidos na outbox no mesmo commit das alterações financeiras.
Publishers reclamam linhas vencidas com `FOR UPDATE SKIP LOCKED` e lease curta,
publicam fora da transação e marcam sucesso depois do envio. Falhas liberam o
lease e agendam backoff. O `eventId` é criado com a alteração financeira e
permanece estável entre tentativas. Eventos são enviados para
`wager-events.fifo`, agrupados por wallet.

O envelope tipado contém `WagerTransactionProcessed` (incluindo `LOSS`),
`WagerTransactionRejected`, `WalletBalanceChanged` (somente quando o saldo
muda) e `WagerTransactionPendingReference`. Montantes no payload são strings
decimais serializáveis, não objetos `Money`.

### Consequências

- A publicação é eventual e pode repetir após crash entre envio e marcação; o
  consumidor deve deduplicar pelo `eventId`.
- A disponibilidade do SQS não participa do commit financeiro.

## ADR-006 — Contratos HTTP, consultas e reconciliação

- **Status:** Accepted
- **Data:** 2026-10-10

### Contexto

O provedor precisa diferenciar erro de payload, conflito, rejeição financeira,
processamento pendente e falha transitória. Operações de leitura não devem
alterar o estado financeiro.

### Decisão

Exigir `Idempotency-Key` no `POST /wagering/transactions`. Mapear payload
inválido para `400`, conflito para `409`, transação rejeitada para `422`,
referência pendente para `202`, falha transitória reconhecida para `503` e
falha interna não classificada para `500` sanitizado. Falha permanente após
reserva é registrada como `FAILED` auditável.

Expor consultas de wallet, ledger e transações por ID interno ou referência do
provedor. Paginar o ledger por `(created_at DESC, id DESC)` com cursor base64url
opaco e limite de 1 a 100. Reconciliação compara saldo armazenado ao total de
créditos menos débitos do ledger; divergências são logadas, medidas e retornadas
sem correção automática.

### Consequências

- DTOs HTTP ficam em `dtos/`, separados dos objetos de domínio e dos inputs de
  aplicação.
- O contrato não expõe mensagens internas de exceções.
- A reconciliação é diagnóstica e mantém o ledger append-only.

## ADR-007 — Observabilidade e comprovação

- **Status:** Accepted
- **Data:** 2026-10-10

### Contexto

O desafio exige diagnóstico sem vazamento de dados financeiros, e mocks
sequenciais não comprovam garantias de concorrência ou integração.

### Decisão

Emitir logs JSON sem payload financeiro completo, incluindo os identificadores
de correlação e operação disponíveis em cada fronteira. `/metrics` expõe
contadores para status, duplicatas, retries, DLQ, conflitos de lock e
divergências de reconciliação, histograma de latência e gauge de atraso da
outbox. Health checks separam liveness de readiness de PostgreSQL e SQS.

Verificar regras puras com testes unitários, contratos HTTP com o servidor
NestJS e persistência/mensageria com PostgreSQL e LocalStack em containers.
Testes de concorrência executam operações paralelas em três aplicações Nest e
comparam o saldo materializado ao ledger. Não implementar autenticação
artesanal, dashboard, event sourcing ou teste de carga: são opcionais ou fora
do escopo obrigatório.

### Consequências

- Métricas são locais ao processo e reiniciam com a aplicação; estado financeiro
  e trabalho pendente continuam duráveis no PostgreSQL/SQS.
- `bun run test:all` executa as suítes unitária, integração e concorrência.
