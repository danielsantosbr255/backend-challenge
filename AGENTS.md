# Instruções do projeto

## Especificação e fluxo de trabalho
- Trate `README.md` como especificação funcional e de avaliação; não enfraqueça suas invariantes para simplificar uma implementação.
- Antes de alterar código, identifique o requisito do README, escreva critérios de aceite observáveis e trabalhe somente na próxima etapa pequena solicitada.
- Siga SDD: resolva ambiguidades consultando a especificação; se ela não decidir o comportamento, explicite a hipótese e registre a decisão em `ARCHITECTURE.md` antes de depender dela.
- Em trabalhos planejados em várias etapas, conclua uma etapa por vez, apresente diff e verificações e aguarde a revisão do usuário antes de avançar.
- Siga TDD em ciclo RGR: escreva primeiro um teste que falha (Red), implemente a menor mudança que o faz passar (Green) e refatore mantendo a suíte verde (Refactor).
- Não altere ou remova um teste só para acomodar a implementação; corrija o comportamento ou justifique uma mudança de especificação.
- Consulte `package.json`, `tsconfig.json` e `compose.yml` antes de escolher comandos ou adicionar dependências; não invente scripts que o projeto não oferece.

## Invariantes financeiras — não negociar
- Nunca represente dinheiro com `number`, `float` ou `double`; use `Money` imutável, `decimal.js` e strings decimais de escala fixa nas fronteiras.
- Valide dados HTTP, SQS e configuração antes que entrem no domínio; o domínio não depende de NestJS, MikroORM, HTTP ou AWS.
- Mantenha regras e transições em objetos de domínio/casos de uso; controllers e handlers de fila validam o transporte e delegam ao mesmo caso de uso.
- Crie e reidrate entidades pelas factories do domínio; `rehydrate` reconstrói estado persistido sem reaplicar regras de transição.
- Grave mudança de wallet, estado da transação, ledger e outbox na mesma transação PostgreSQL; inclua a inbox nessa transação para mensagens SQS.
- Serialize atualizações por `walletId` no banco e reforce unicidade, não-negatividade e demais invariantes com constraints/migrations; incremente `version` somente quando o saldo mudar.
- Não use locks/caches em memória nem FIFO como garantia de correção; o banco deve proteger invariantes entre instâncias.
- Nunca atualize ou apague lançamentos do ledger; corrija erros com uma nova movimentação compensatória.
- Persista a chave de idempotência com escopo único documentado e hash canônico do payload de negócio; payload igual devolve o resultado original e payload diferente conflita.
- Mantenha `OPENING` interno, `LOSS` sem lançamento e reversões limitadas à referência válida, de mesmo valor e não revertida anteriormente pelo mesmo tipo.
- Confirme (ack/delete) uma mensagem SQS somente depois do commit; classifique falhas de negócio, transitórias e permanentes para ack, retry ou DLQ.
- Publique eventos somente a partir da outbox confirmada; mantenha `eventId` estável porque uma publicação pode ser repetida.
- Preserve referências fora de ordem como pendentes com retry limitado; não as rejeite apenas por ainda não terem chegado.

## Arquitetura e TypeScript
- Mantenha um monólito modular NestJS; organize módulos por capacidade de negócio e use portas nas fronteiras reais de I/O, sem criar abstrações genéricas para uso único.
- Preserve dependências apontando para dentro; módulos de composição conectam adaptadores sem fazer a infraestrutura depender da camada HTTP.
- Mantenha controllers HTTP, consumidores SQS e workers finos; eles adaptam entradas e chamam casos de uso, sem duplicar regras.
- Use MikroORM e as dependências já instaladas; não introduza outro ORM nem Prisma.
- Preserve `strict` e as verificações atuais do `tsconfig.json`; nunca desligue uma regra estrita para fazer o código compilar.
- Não use `any`, inclusive em casts; trate entradas externas como `unknown`, valide-as e só então converta para tipos do domínio.
- Prefira tipos explícitos para contratos, uniões discriminadas e narrowing; evite `as`, `!` e supressões do compilador quando uma validação ou modelagem correta resolve o problema.
- Use Bun 1.x para runtime, scripts, dependências e testes; mantenha `bun.lock` sincronizado e não troque para npm, pnpm ou Jest.
- Não implemente autenticação artesanal; ela é opcional no desafio e, se ficar fora do escopo, documente a decisão e o ponto de extensão em `ARCHITECTURE.md`.
- Mantenha segredos em ambiente local não versionado; use `.env.example` para documentar variáveis e nunca registre credenciais/payloads financeiros nem retorne erros internos brutos ao cliente.

## Testes e verificações
- Cubra `Money` e regras puras com testes unitários; cubra migrations, constraints, inbox/outbox e recuperação com PostgreSQL e LocalStack/MiniStack reais em containers.
- Teste concorrência com operações realmente paralelas e banco real; mocks sequenciais não comprovam idempotência ou proteção contra saldo negativo.
- Valide rotas e status HTTP com teste de integração pelo servidor NestJS; chamar métodos do controller não comprova o contrato HTTP.
- Para integração local, suba as dependências existentes com `docker compose -f compose.yml up -d postgres localstack` e consulte `scripts/init-localstack.sh` para as filas provisionadas.
- Use os scripts existentes conforme o escopo: `bun run typecheck`, `bun run test`, `bun run test:integration` e `bun run test:all`.
- Antes de concluir uma mudança, rode ao menos o typecheck e os testes pertinentes; informe com clareza o que foi executado e o que depende de serviços locais.

## Escopo e qualidade
- Prefira a menor mudança que cumpra os critérios de aceite; aplique DRY quando houver duplicação real e YAGNI para não criar funcionalidades, camadas ou generalizações antecipadas.
- Mantenha nomes e funções focados; extraia abstrações quando reduzirem acoplamento ou duplicação concreta, não apenas para seguir um padrão nominal.
- Não adicione autenticação, dashboards, microserviços, event sourcing ou teste de carga antes dos requisitos obrigatórios do README.
- Atualize `ARCHITECTURE.md` quando uma mudança alterar decisões, trade-offs, códigos de falha ou limites operacionais; mantenha o README voltado a setup e comandos.
