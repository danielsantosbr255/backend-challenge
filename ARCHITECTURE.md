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
`wager`. O domínio não depende de NestJS, HTTP, SQS ou MikroORM. Casos de uso
usam injeção de dependências e observabilidade do NestJS, mas acessam I/O
por portas específicas; módulos
de composição conectam controllers, workers e adaptadores. Usar Bun, TypeScript
estrito e MikroORM com PostgreSQL, conforme a stack obrigatória e a preferência
do README.

Autenticação fica fora do escopo, como permitido pelo README. Se for adicionada,
deve usar um Identity Provider externo. O ponto de acoplamento HTTP são os
controllers de provedores em `src/modules/wallet/wallet.controller.ts` e
`src/modules/wager/wager.controller.ts`, nos quais um `AuthGuard` pode ser
aplicado sem proteger os health checks nem a entrada interna SQS.
O desenho previsto é OIDC com validação de tokens emitidos pelo IdP e vínculo
entre a identidade autenticada e o `providerId` autorizado, impedindo que um
provedor use o identificador de outro. Não há gestão local de credenciais.

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
inicial cria wallet, transação, crédito no ledger e os eventos
`WagerTransactionProcessed`/`WalletBalanceChanged` atomicamente; saldo zero não
cria lançamento.

Aceitar códigos ISO 4217 em maiúsculas nas fronteiras HTTP/SQS, mantendo
`Money` capaz de operar em moedas distintas sem conversão cambial. Valores de
entrada podem ter zero, uma ou duas casas decimais e são normalizados para duas;
escala excedente é rejeitada, sem arredondamento financeiro implícito.
O limite de uma movimentação/saldo é `9999999999999999.99`. Todas as operações
externas exigem valor positivo, inclusive `LOSS`, cujo valor registra o
resultado sem movimentar a wallet. Abertura aceita zero.

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
UUIDs são normalizados para minúsculas antes das comparações e do hash.

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
- Os índices de histórico mantêm `(wallet_id, created_at DESC, id DESC)` com
  definição SQL explícita suportada pelo MikroORM. O parser de índices da
  versão instalada confunde `id` com o sufixo de `wallet_id` e perde o último
  `DESC` na introspecção estrutural. As migrations preservam a definição real;
  o teste de schema confere a ordenação diretamente em `pg_indexes`, além do
  `migration:check`. Não há patch do ORM ou mudança de ordenação para contornar
  o problema.

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

A janela nominal de cerca de 15 segundos, mais polling, foi escolhida para
demonstrar recuperação e expiração em tempo curto no desafio. É um limite
operacional explícito: referências que chegam depois da rejeição não reabrem
a operação; um ambiente real precisa ajustar a política ao atraso esperado
do provedor. Falhas de infraestrutura não consomem tentativas confirmadas.

Uma inbox já confirmada resolve a operação por `(providerId,
externalTransactionId)`, identidade de negócio única persistida. O replay da
mesma mensagem/hash retorna o resultado original mesmo se a chave de transporte
mudar; mudar o payload do mesmo `messageId` gera `INBOX_MESSAGE_CONFLICT`.
`InboxMessage.receive/rehydrate` e `markProcessed` encapsulam o estado, e o
registro processado só fica visível junto com o commit financeiro.

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

`OutboxMessage.enqueue/rehydrate` encapsula publicação e retry. Tentativas
contam envios concluídos (sucesso ou falha registrada); um processo morto
antes de registrar o resultado deixa o lease expirar. Retry usa 1, 2, 4, 8...
segundos, limitado a 300. Publicar conserva o `eventId`; uma atualização
condicionada ao dono do lease evita que uma instância confirme a claim de outra.

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

A classificação de persistência considera SQLSTATE e códigos de rede do driver,
além das classes de exceção do MikroORM. Falhas de conexão (`08`), recursos
temporariamente indisponíveis (`53`), serialização/deadlock (`40001`/`40P01`),
lock indisponível (`55P03`), cancelamento de consulta (`57014`) e encerramento ou
recuperação do servidor (`57P01`/`57P02`/`57P03`) não tornam a operação terminal.
Erros de rede reconhecidos também são transitórios. O transporte HTTP responde
`503`; SQS mantém a mensagem disponível para retry conforme o backoff.

Somente falhas identificadas de schema/permissão, constraints de persistência
ou recurso SQL não suportado são classificadas como infraestrutura permanente.
Após a reserva, elas podem produzir `FAILED/PERMANENT_INFRASTRUCTURE_FAILURE`
auditável em uma transação separada, sem saldo, ledger ou inbox parcial. Erros
desconhecidos, inclusive `P0001` sem semântica adicional, são propagados e
retornam `500` sanitizado; não são convertidos automaticamente em `FAILED`.
Os testes de falha permanente injetam `42501` (permissão negada), em vez de
presumir permanência a partir de uma mensagem de erro genérica.

Expor consultas de wallet, ledger e transações por ID interno ou referência do
provedor. Paginar o ledger por `(created_at DESC, id DESC)` com cursor base64url
opaco e limite de 1 a 100. Reconciliação compara saldo armazenado ao total de
créditos menos débitos do ledger; divergências são logadas, medidas e retornadas
sem correção automática.

`POST /wallets/:walletId/reconciliation` usa o identificador da rota e não
exige corpo. A soma líquida e a diferença são calculadas em uma consulta
PostgreSQL, com `NUMERIC` exato e strings de duas casas. Totais históricos e
diagnósticos não recebem o limite de uma coluna de movimentação; isso permite
inspecionar inclusive divergências negativas ou fora desse limite.

### Taxonomia e transições

| Código | Significado / ação |
|---|---|
| `INSUFFICIENT_FUNDS` | `BET` rejeitada; saldo não muda; não repetir sem nova intenção de negócio |
| `REVERSAL_INSUFFICIENT_FUNDS` | reversão rejeitada por saldo insuficiente; sem débito parcial |
| `WAGER_REFERENCE_MISMATCH` | referência incompatível ou terminal sem processamento; corrigir a referência |
| `WAGER_REFERENCE_NOT_FOUND` | limite de consultas duráveis esgotado; rejeição definitiva |
| `WAGER_ALREADY_REVERSED` | referência já revertida pelo mesmo tipo; rejeição definitiva |
| `WAGER_IDEMPOTENCY_CONFLICT` | mesma key/payload diferente; HTTP 409, SQS ack sem efeito |
| `WAGER_EXTERNAL_TRANSACTION_CONFLICT` | mesma identidade de negócio sob outra key; HTTP 409, SQS ack sem efeito |
| `INBOX_MESSAGE_CONFLICT` | mesmo messageId/payload diferente; DLQ |
| `WAGER_WALLET_NOT_FOUND` / `WAGER_WALLET_MISMATCH` | wallet ausente ou player/moeda incompatível; HTTP 404/422, SQS ack |
| `INVALID_MONEY` / `INVALID_WAGER_AMOUNT` | entrada inválida ou montante não positivo; HTTP 400, envelope inválido SQS em DLQ |
| `TRANSIENT_INFRASTRUCTURE_FAILURE` | falha reconhecida e recuperável; HTTP 503 sanitizado, SQS retry/redrive |
| `PERMANENT_INFRASTRUCTURE_FAILURE` | `FAILED` auditável após reserva, sem efeito financeiro; HTTP 500, SQS DLQ |

Erros de DTO/header usam `BAD_REQUEST` (400). Wallet duplicada usa
`WALLET_ALREADY_EXISTS` (409); consultas ausentes usam `WALLET_NOT_FOUND` ou
`WAGER_TRANSACTION_NOT_FOUND` (404). Violações internas de estado/persistência
e erros não classificados retornam 500 sanitizado e não criam um `FAILED`
por suposição. Não é preciso reenviar uma rejeição usando a mesma key:
ela reproduzirá a mesma decisão.

Transições externas: `PENDING → PROCESSED | REJECTED | PENDING_REFERENCE | FAILED`;
recuperação: `PENDING_REFERENCE → PROCESSED | REJECTED`, ou permanece pendente
com nova data/tentativa. Estados terminais não são reabertos. `OPENING` nasce
internamente `PROCESSED`; `LOSS` termina `PROCESSED` sem ledger ou incremento
de versão. Reidratação reconstrói o estado sem reaplicar essas transições.

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

O bootstrap usa `ConsoleLogger` em JSON com parâmetros estruturados; queries
e parâmetros do ORM não são logados, inclusive em development. HTTP/SQS
registram os IDs disponíveis, usando `unknown` quando não há transação criada.
Resultados confirmados pelo worker de referências também alimentam métricas
de status/latência. `wager_dlq_messages_total` conta envios explícitos pela
aplicação; `wager_dlq_messages` mede a profundidade aproximada da DLQ e cobre
redrive do broker, sem consumir mensagens da DLQ. Gauge é atualizado no polling
(long poll de até 10 segundos), portanto a observação é eventual.

Readiness consulta as três filas. SQS usa até duas tentativas de SDK, conexão
de até 3 segundos e request de até 15 segundos, maior que o long poll.
PostgreSQL limita conexão a 5 segundos, cada statement a 10 segundos e
transações ociosas a 15 segundos. Shutdown aguarda o trabalho em andamento;
os timeouts evitam esperar indefinidamente em uma chamada de I/O. A visibilidade
SQS é de 60 segundos; em uma reentrega prematura, inbox e locks continuam
protegendo o saldo, sem depender do lease do broker para correção.

O encerramento pelo lifecycle `app.close()` é exercitado nos testes reais de
integração. O suporte a sinais de encerramento depende do sistema operacional;
`SIGTERM` de um subprocesso Bun no Windows não é tratado como prova de
shutdown gracioso. A recuperação após interrupção abrupta é verificada
separadamente pelo teste de crash.

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
- Migrations são aplicadas e totalmente revertidas em banco descartável criado
  pelo teste, sem depender do estado da base principal. O usuário PostgreSQL do
  Compose tem permissão para criar esse banco.
- O teste de crash inicia um processo Bun, bloqueia somente as chamadas SDK de
  ack/publicação após o commit/claim e o mata com `SIGKILL`. Um segundo processo
  recebe a mensagem original e recupera a outbox. O teste antecipa a expiração
  do lease abandonado para evitar uma espera de 60 segundos; não cria eventos
  artificiais. Confere IDs estáveis, um débito, uma inbox e saldo igual ao ledger.
