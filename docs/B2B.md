# CARINA — Plataforma B2B de Inteligência Financeira
### O que vendemos para bancos, fintechs, bigtechs e startups
#### Versão 1.0 — Junho 2026

---

## A IDEIA CENTRAL

Quatro das empresas mais valiosas de tecnologia do mundo foram construídas sobre
um princípio simples: **vender infraestrutura para quem constrói produtos**.

A Stripe não compete com os bancos — vende a eles a infraestrutura de pagamento.
A Twilio não compete com as operadoras — vende a elas a camada de comunicação.
A Scale AI não compete com a OpenAI — vende a ela os dados que treinam os modelos.
O Decagon não compete com o suporte humano — vende a fintechs o trabalho que o
suporte humano faz, executado por agentes, cobrado por resolução.

O CARINA segue a mesma lógica, aplicada ao mercado financeiro brasileiro:

> **Não competimos com bancos, fintechs ou gestoras.
> Vendemos a eles a inteligência financeira que nenhum deles consegue construir
> sozinho — em dados, agentes, infraestrutura quantitativa e curadoria de
> conhecimento financeiro brasileiro.**

---

## OS TRÊS PRODUTOS B2B

### PRODUTO 1 — CARINA Agent API
*Os 12 agentes do CARINA disponíveis via API para qualquer empresa*

O que é: os mesmos 12 agentes que operam no produto consumer do CARINA —
construídos, testados e validados com clientes reais — disponíveis via API
para qualquer banco, fintech, bigtech ou startup integrar ao seu produto.

Não é um chatbot. Não é um assistente genérico. São 12 especialistas financeiros
autônomos que **agem**: analisam, calculam, monitoram, propõem e executam
(com aprovação humana obrigatória para ações irreversíveis).

O cliente B2B não gerencia infraestrutura de IA. Não treina modelo. Não contrata
engenheiro de ML. Chama a API, define o contexto do negócio em linguagem natural
(via AOPs — Agent Operating Procedures), e os agentes entregam o trabalho.

---

**OS 12 AGENTES DISPONÍVEIS VIA API**

**Tier 1 — Cognitive (pensamento e estratégia)**

| Agente | O que entrega via API para o cliente B2B |
|---|---|
| **Navigator** | Interface conversacional financeira em português BR. Entende intent, classifica e roteia. Substitui o bot de atendimento genérico por um especialista financeiro. |
| **Strategist** | Planejamento patrimonial de longo prazo com Monte Carlo e goal-based. Um banco chama esse agente antes de cada reunião de RM — ele já chega com o plano preparado. |
| **Researcher** | Pesquisa de mercado, leitura de relatórios, fact-check. Uma gestora chama esse agente para monitorar notícias relevantes para a carteira de cada cliente automaticamente. |
| **Assessor Liaison** | Ponte entre sistemas automatizados e o assessor humano. Quando o agente encontra uma situação que exige julgamento humano, ele formula a pergunta certa e registra a resposta. |

**Tier 2 — Operational (ação e execução)**

| Agente | O que entrega via API para o cliente B2B |
|---|---|
| **Monitor** | Vigilância 24/7 de preço, volume e notícias para qualquer carteira. Uma corretora chama esse agente para monitorar as carteiras de todos os clientes premium simultaneamente, sem time dedicado. |
| **Executor** | Prepara e submete ordens financeiras com classificação de risco. Toda ação irreversível passa por aprovação humana (agentic-inbox). Nunca age sozinho com dinheiro. |
| **Sync** | Consolidação automática de Open Finance. Conecta 6+ bancos e corretoras, deduplica posições e transações, entrega portfólio consolidado em tempo real. |
| **Categorizer** | Categorização automática de transações com ML + LLM fallback. Detecta parcelas, recorrências, padrões de gasto. Uma fintech de crédito usa isso para entender o comportamento financeiro real do tomador. |

**Tier 3 — Analytical (análise profunda)**

| Agente | O que entrega via API para o cliente B2B |
|---|---|
| **Insight** | Análise de portfólio: concentração, anomalias, desvios em relação a objetivos. Uma gestora chama esse agente para gerar o relatório de cada cliente automaticamente antes do fechamento mensal. |
| **Predictor** | Projeção de fluxo de caixa 12–36 meses com cenários base/otimista/pessimista e premissas explícitas. Saída estruturada em JSON (Pydantic) — integra direto em qualquer sistema. |
| **Tax Optimizer** | IR em tempo real, tax loss harvesting, análise offshore vs. Brasil. Identifica e propõe oportunidades tributárias no momento exato em que aparecem. Um banco usa isso para oferecer advisory tributário proativo sem contratar mais contadores. |
| **Rebalancer + Risk** | VaR, correlação, stress test, drift de alocação. Proposta de rebalanceamento fundamentada em risco real, não em regra de percentual fixo. |

---

**COMO O CLIENTE B2B USA OS AGENTES**

Três modos de integração, dependendo da maturidade do cliente:

*Modo 1 — Agente único:* o cliente integra um agente específico para um caso de
uso pontual. Exemplo: uma fintech de crédito integra só o Categorizer para
enriquecer o perfil de crédito com dados de comportamento financeiro real.
Tempo de integração: horas. Custo: por resolução.

*Modo 2 — Time de agentes configurado:* o cliente define um conjunto de agentes
e os fluxos entre eles via AOPs (Agent Operating Procedures em linguagem natural).
Exemplo: um banco configura Monitor + Insight + Tax Optimizer para rodar toda sexta
para cada cliente premium e gerar um briefing para o RM na segunda.
Tempo de integração: 2–6 semanas (onboarding white-glove). Custo: contrato anual.

*Modo 3 — Plataforma completa white-label:* o cliente usa os 12 agentes como
engine completo do seu produto de wealth management. A interface é da marca do
cliente; o motor é o CARINA. Exemplo: "XP Wealth AI", "BTG Intelligence".
Tempo de integração: 6 semanas. Custo: revenue share + fee mensal.

---

**MODELO DE PRECIFICAÇÃO**

Por trabalho realizado, não por assento. O cliente paga pela resolução:

| Tipo de trabalho | Agentes envolvidos | Preço base B2B |
|---|---|---|
| **Query** | Navigator ou agente único | R$ 1,50/resolução |
| **Analysis** | Insight, Risk, Predictor (1 agente) | R$ 7,50/resolução |
| **Multi-agent Analysis** | 2+ agentes em paralelo | R$ 15,00/resolução |
| **Optimization** | Tax Optimizer, Rebalancer | R$ 30,00/resolução |
| **Execution** | Executor + aprovação | R$ 75,00 + fee sobre valor |
| **Monitoramento 24/7** | Monitor (por cliente monitorado) | R$ 50,00/cliente/mês |

Contratos enterprise (acima de 1.000 resoluções/mês): desconto por volume,
SLA garantido, suporte dedicado. Range: R$ 95K–590K/ano.

---

**QUEM COMPRA E POR QUÊ**

*Fintechs de investimento (Warren, Rico, NuInvest):* adicionam análise profunda
de portfólio e tax optimization sem construir 12 agentes internamente.
Time-to-market de meses vira dias. Diferencial de produto com custo marginal baixo.

*Bancos com segmento de alta renda (Itaú, Bradesco, Santander, BTG):* o RM humano
passa a ter 12 co-pilotos de IA que monitoram todas as carteiras 24/7, preparam
análises antes de cada reunião e identificam oportunidades tributárias em tempo real.
O banco multiplica a produtividade do RM por 5x sem contratar.

*Startups de crédito:* o Categorizer + Sync entregam o perfil financeiro real do
tomador via Open Finance — dado que o score de crédito tradicional não captura.

*Family offices:* automatizam relatórios, consolidação multi-núcleo e análise de
risco com custo operacional 70% menor que um time interno equivalente.

*Plataformas de RH e benefícios:* Predictor + Insight para planejamento financeiro
de colaboradores — o benefício de saúde financeira que toda empresa grande quer
oferecer mas nenhuma consegue escalar.

**O que diferencia de um chatbot comum:**
O Decagon provou que a diferença não é o modelo de IA — é a verticalização.
Um agente horizontal de CX resolve ticket de suporte.
Um agente CARINA resolve a decisão de investimento que vale R$ 500K.
O valor por interação é ordens de magnitude maior, justificando o preço.

---

### PRODUTO 2 — CARINA Data Engine
*Inspirado na Scale AI: infraestrutura de dados financeiros BR proprietários*

O que é: o motor de dados financeiros brasileiros mais completo disponível via API.
Não é um agregador de dados de mercado — é uma **camada de inteligência** sobre
dados financeiros que nenhum provedor externo tem: dados proprietários construídos
a partir da operação do CARINA com clientes reais, enriquecidos com contexto
comportamental, tributário e patrimonial.

**As três camadas do Data Engine:**

*Camada 1 — Market Data BR (dados de mercado normalizados)*
Ações, FIIs, ETFs, BDRs, renda fixa, Tesouro Direto, fundos, derivativos B3.
Macro BCB (Selic, IPCA, CDI, câmbio PTAX). Tudo normalizado num schema único,
sem depender de 5 fontes diferentes com formatos inconsistentes.
Fonte: brapi.dev + EODHD + B3 feed direto (futuro) — abstraídos numa API limpa.

*Camada 2 — Behavioral Finance Data (dado proprietário — o moat real)*
Padrões de comportamento de investidores HNWIs brasileiros agregados e anonimizados:
como alocam, quando rebalanceiam, quais gatilhos levam a decisões, como respondem
a volatilidade por faixa de patrimônio. Nenhum provedor externo tem isso.
Esse é o equivalente do "ground truth financeiro brasileiro" que a Scale AI vende
para treinar modelos — mas para o mercado BR e gerado pela operação do CARINA.
Vendido via API para fintechs que querem treinar modelos proprietários de scoring,
recomendação e risco.

*Camada 3 — Agent Evaluation Layer (avaliação de agentes financeiros — o "SEAL BR")*
Benchmarks e datasets para avaliar se um agente de IA responde corretamente a
perguntas financeiras brasileiras: tributação, regulação CVM, Open Finance, products
específicos do mercado BR. A Scale AI faz isso para LLMs genéricos; o CARINA faz
para o vertical financeiro brasileiro.
Vendido para: bancos com equipes de IA que precisam avaliar seus próprios modelos,
fintechs em processo de certificação CVM/Bacen, consultorias de compliance de IA.

**Modelo de precificação:** SaaS por volume de chamadas + contratos de dados custom.

**Quem compra e por quê:**

*Bancos construindo modelos próprios:* precisam de dados rotulados de qualidade
para treinar scoring de crédito, detecção de fraude, recomendação de produto.
O CARINA entrega dados financeiros brasileiros com contexto comportamental que
eles não conseguem gerar internamente na escala e qualidade necessárias.

*Bigtechs entrando em finanças (Google, Amazon, Mercado Livre):* precisam entender
o comportamento financeiro do brasileiro antes de lançar produtos. O Data Engine
é a forma mais rápida de ter esse contexto sem construir do zero.

*Startups de IA financeira:* o benchmarking de agentes financeiros em português e
contexto brasileiro é um problema não resolvido. Qualquer startup que queira afirmar
"nosso modelo entende o mercado brasileiro" precisa de um dataset de avaliação
confiável. O CARINA é o único que tem.

---

### PRODUTO 3 — CARINA Builder Layer
*Inspirado na Hyperliquid: infraestrutura aberta onde terceiros constroem produtos*

O que é: uma camada de infraestrutura regulada sobre a qual quants, fintechs e
gestoras fazem deploy de estratégias, produtos e automações financeiras — usando
os dados, agentes e conectividade do CARINA como base.

Analogia direta: o Hyperliquid criou o HIP-3, onde qualquer builder pode fazer
deploy de um DEX de perpétuos sobre a liquidez do HyperCore. O CARINA cria o
equivalente regulado na B3 e no Open Finance brasileiro.

**O que um builder pode construir em cima do CARINA:**

- Estratégia quantitativa que acessa dados de mercado BR normalizados + backtesting
  com dados históricos limpos, sem montar infraestrutura própria.
- Produto estruturado (fundo, carteira administrada) que usa os agentes CARINA
  para monitoramento, rebalanceamento e relatórios — sem contratar gestora própria.
- Automação de wealth management white-label para corretora ou banco, usando os
  12 agentes do CARINA como engine e a marca do cliente na interface.
- Pipeline de dados financeiros customizado: Open Finance → normalização →
  enriquecimento → destino (data warehouse, modelo de crédito, sistema de RM).

**O flywheel (o que fez o Hyperliquid gerar $800M de receita sem VC):**
Quanto mais builders constroem em cima do CARINA, mais dados proprietários
o CARINA gera, mais o Data Engine melhora, mais builders chegam.
O efeito de rede não é viral (como redes sociais) — é de infraestrutura:
cada builder que integra aumenta o custo de troca para ele e para seus clientes.

**Modelo de precificação:** revenue share sobre o produto do builder (10–30%) +
fee de infraestrutura mensal por builder ativo.

**Quem compra e por quê:**

*Gestoras independentes:* constroem produtos mais sofisticados sem montar
infraestrutura de dados e IA internamente. Competem com grandes bancos em
qualidade de análise, mantendo a autonomia de gestão.

*Quants e fintechs de trading:* acessam dados limpos, backtesting e conectividade
com B3 via parceiros CTVM sem negociar contratos institucionais individualmente.

*Corretoras mid-size:* lançam um produto de wealth management autônomo para sua
base de clientes premium usando o CARINA como engine — sem anos de desenvolvimento.

**Nota regulatória importante:** a Builder Layer opera dentro do arcabouço CVM
(Resolução 175 para fundos, regulação de consultores de valores mobiliários) e
via parceiros CTVM para execução. Não é uma infraestrutura permissionless — é
regulada, auditável e com compliance desde o dia 1.

---

## O WATCHTOWER — COMPLIANCE COMO PRODUTO

Toda empresa financeira que usa IA tem o mesmo problema: como provar para o regulador
(CVM, Bacen, LGPD) que o agente não disse nada errado?

O CARINA resolve isso com o **Watchtower** — nossa camada de observabilidade e
compliance em tempo real, disponível como produto standalone para qualquer empresa
que use agentes de IA em contexto financeiro.

O que o Watchtower faz em tempo real para cada interação de agente:
- Detecta afirmações de certeza em projeções financeiras (violação de suitability)
- Identifica vazamento de PII em respostas (LGPD)
- Verifica se agente conversacional está fazendo recomendação de compra/venda
  sem autorização (conflito com regulação CVM de consultores)
- Confirma presença de disclaimers obrigatórios (tax advice, previsões)
- Gera trilha de auditoria completa para cada interação (quem perguntou, qual
  agente respondeu, qual foi a ação, qual o resultado, timestamp, modelo usado)

**Quem compra:** qualquer empresa financeira usando LLM em produto para clientes
— banco, fintech, seguradora, gestora. O prazo regulatório está chegando; o
Watchtower é o seguro de compliance de IA para o mercado financeiro brasileiro.

**Modelo de precificação:** SaaS mensal por volume de interações auditadas.

---

## O MODELO DE ONBOARDING B2B

O Decagon provou que o onboarding "white-glove" é parte do produto, não overhead.
Contratos de $400K/ano são vendidos porque a empresa manda Agent Product Managers
e Forward-Deployed Engineers que ficam 6 semanas implementando com o cliente.

O CARINA replica esse modelo para o mercado financeiro brasileiro:

**Semanas 1–2:** discovery do contexto financeiro do cliente B2B. Quais produtos
oferecem, quais dados têm, quais regulações os restringem, quais são as dores
do time de produto e do time de compliance.

**Semanas 3–4:** configuração dos AOPs (Agent Operating Procedures) em linguagem
natural. O cliente define os fluxos; o CARINA traduz em automações. Nenhum
engenheiro do cliente precisa entender o código interno.

**Semanas 5–6:** deploy, testes com dados reais do cliente (sandbox regulado),
validação do Watchtower, treinamento do time. Go-live.

**Pós go-live:** dashboard de uso (trabalhos realizados, taxa de resolução,
economia de tempo humano, flags de compliance). Revisão mensal. Expansão de AOPs.

---

## DEFESA COMPETITIVA (POR QUE NÃO É FÁCIL COPIAR)

**Dado proprietário é o moat principal.**
O Behavioral Finance Data (Camada 2 do Data Engine) só existe porque o CARINA
opera com clientes reais. Quanto mais clientes consumer o CARINA tem, mais rico
o dado comportamental fica, mais valioso o Data Engine B2B fica.
É o mesmo flywheel que a Scale AI usou: a operação gera o dado, o dado vira produto,
o produto financia mais operação.

**Verticalização financeira BR é barreira de entrada.**
Construir agentes que entendem tributação de FII, isenção de R$20K em ações,
Come-cotas de fundos, normas CVM, PTAX, debêntures incentivadas — isso leva anos
de iteração com clientes reais no Brasil. Um player generalista de IA não tem isso.

**Regulação é barreira, não obstáculo.**
Para um player de fora do Brasil, entrar no mercado financeiro BR regulado é
complexo e demorado. O CARINA já está construindo com compliance desde o dia 1,
com parceiros CTVM e estrutura CVM. Isso vira vantagem competitiva quando o
mercado amadurecer.

**Efeito de rede da Builder Layer.**
Cada builder que integra traz seus clientes para a plataforma. Cada cliente gera
dados. Cada dado melhora os agentes. Os builders não saem porque seus produtos
dependem da infraestrutura. É o mesmo efeito de rede que travou os usuários do
Hyperliquid mesmo quando competidores tentaram copiar.

---

## NÚMEROS PARA O PITCH B2B

| Métrica | Referência | CARINA (meta ano 2) |
|---|---|---|
| ARR target Série A | US$ 3–5M (benchmark global 2026) | R$ 3–8M |
| Crescimento mensal | > 15% (benchmark VC 2026) | > 15% |
| NRR target | > 120% (expansão de uso) | > 120% |
| Ticket médio B2B | R$ 95K–590K/ano (Decagon benchmark) | R$ 120K–400K/ano |
| Clientes B2B target ano 1 | 10–20 contratos | 10–15 gestoras/fintechs |
| Custo de infraestrutura | — | < R$ 200/mês (MVP) |

---

## PARA QUEM VENDEMOS (SEGMENTAÇÃO B2B)

### Tier A — Grandes bancos e corretoras (contratos > R$ 500K/ano)
Itaú, Bradesco, BTG, XP, Santander, Nubank. Vendem wealth management para clientes
premium. O CARINA vira o engine de IA do produto deles. Ciclo de venda: 6–12 meses.
Decisor: C-suite de tecnologia + head de wealth. Entrada via PoC pago.

### Tier B — Gestoras e fintechs de investimento (R$ 120K–500K/ano)
Warren, Rico, NuInvest, Magnetis-BTG, Avenue, Órama. Já têm base de clientes;
precisam de diferencial de produto. O CARINA entrega análise profunda que elas
não constroem internamente. Ciclo de venda: 2–4 meses. Decisor: CPO + CTO.

### Tier C — Family offices e startups financeiras (R$ 60K–180K/ano)
Family offices independentes, startups de crédito com componente de wealth,
plataformas de investimento para empresas. Ciclo de venda: 1–3 meses.
Decisor: fundador ou COO. Entrada via self-serve + onboarding assistido.

### Tier D — Bigtechs entrando em finanças (Data Engine — contrato custom)
Google, Amazon, Mercado Livre, iFood (serviços financeiros). Não querem o produto
completo — querem os dados e os benchmarks de avaliação de agentes financeiros BR.
Ciclo de venda: 3–9 meses. Decisor: head de IA + compliance. Deal size: R$ 500K+.

---

## O QUE DIZEMOS NA REUNIÃO

Com um banco:
> "Seu time de RM atende 200 clientes por pessoa. Com o CARINA, cada RM passa a
> ter um co-piloto que monitora todas as carteiras 24/7, prepara a análise antes
> de cada reunião e identifica oportunidades tributárias em tempo real. Você não
> substitui o RM — você multiplica a produtividade dele por 5x, com compliance
> auditável em cada interação."

Com uma fintech de investimento:
> "Você tem a distribuição. Nós temos o motor. Seus clientes premium vão ter
> análise de portfólio, tax optimization e projeção de fluxo de caixa que hoje
> só existe no BTG Private — cobrado como R$ 2.500/mês por cliente. Você oferece
> isso como diferencial sem construir 12 agentes internamente."

Com uma bigtech:
> "Você está entrando em finanças no Brasil. O mercado financeiro brasileiro tem
> peculiaridades que nenhum dataset global captura: tributação de FII, Come-cotas,
> isenção de R$20K, PTAX, debêntures incentivadas. Nosso Data Engine é o atalho
> de 2 anos de desenvolvimento que você precisaria para entender esse mercado."

Com uma startup:
> "Você paga por resolução, não por assento. Não tem custo fixo de IA. Não tem
> engenheiro de ML para manter. Chama a API, define o contexto do seu produto em
> linguagem natural, e os agentes do CARINA fazem o trabalho. Você foca em
> distribuição."

---

## ROADMAP B2B (36 MESES)

**Meses 1–6 (agora): construir o motor**
- Finalizar Agent API (metering por trabalho + Watchtower + AOPs)
- Primeiros 3–5 contratos piloto com gestoras independentes (Tier C)
- Validar: taxa de resolução > 70%, NRR > 100%, tempo de onboarding < 6 semanas

**Meses 6–18: escalar o canal**
- 10–15 contratos ativos (mix Tier B e C)
- Lançar Data Engine — Camada 1 (Market Data BR normalizado)
- Primeiro contrato Tier A (banco ou corretora grande)
- Levantar Série A com R$ 3–8M ARR recorrente

**Meses 18–36: abrir a plataforma**
- Lançar Builder Layer (auto-serve para quants e fintechs)
- Data Engine — Camada 2 (Behavioral Finance Data proprietário)
- Primeiro contrato Tier D (bigtech)
- Watchtower como produto standalone para o mercado
- Expansão para América Latina (México, Colômbia, Chile — mesmos problemas,
  menor escala, menor competição)

---

## RISCOS HONESTOS

**Risco regulatório é o maior.** Consultoria de valores mobiliários e gestão de
recursos exigem autorização prévia da CVM. O CARINA opera como tecnologia para
quem já tem a licença — não como gestor direto. Mas à medida que os agentes
ficam mais autônomos, a linha regulatória pode ser questionada. Compliance desde
o dia 1 é obrigatório, não opcional.

**Ciclo de venda enterprise é longo.** Banco grande pode levar 12 meses para
assinar. A estratégia de entrar por gestoras e fintechs mid-size (Tier B/C) não
é só pra gerar ARR — é para construir casos de uso provados antes de sentar com
o Itaú.

**Dado proprietário leva tempo para acumular.** O Behavioral Finance Data só fica
valioso com volume de clientes consumer. A sequência correta é consumer primeiro,
B2B depois — não ao contrário.

**Privacidade de dado B2B.** Quando um banco integra o CARINA e os dados dos
clientes dele passam pelos agentes, os contratos de DPA (Data Processing Agreement)
precisam ser irrepreensíveis. ISO 27001 e SOC 2 são necessidades, não diferenciais,
para fechar com bancos.

---

*Documento vivo. Atualizado conforme o produto e o mercado evoluem.*
*Versão 1.0 — Junho 2026*
