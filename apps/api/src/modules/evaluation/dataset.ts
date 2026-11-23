/**
 * Dataset curado do SEAL BR: 42 casos com gabarito determinístico.
 *
 * GERADO a partir de `legacy/python/carina/data_engine/eval_dataset.py` (script descartável que
 * importa `DATASET` e despeja o conteúdo sem alterá-lo). Este arquivo fica SÓ na API: o gabarito
 * (`expectedFacts`, `forbidden`, `reference`) nunca vai para `packages/shared` nem sai por rota.
 *
 * Alternativas cobrem grafias usuais; `forbidden` só carrega erros clássicos que uma resposta
 * CORRETA não citaria. `reference` é a fonte normativa.
 */
import type { EvalCategory } from "@carina/shared";

/** Um fato que a resposta deve conter (qualquer alternativa satisfaz). */
export interface ExpectedFact {
  readonly description: string;
  readonly alternatives: readonly string[];
}

export interface EvalCase {
  readonly id: string;
  readonly category: EvalCategory;
  readonly difficulty: string;
  readonly question: string;
  readonly expectedFacts: readonly ExpectedFact[];
  readonly forbidden: readonly ExpectedFact[];
  readonly reference: string;
}

export const EVAL_DATASET: readonly EvalCase[] = [
  {
    id: "acoes-isencao-20k",
    category: "tributacao",
    difficulty: "easy",
    question:
      "Uma pessoa física vendeu R$ 18.000 em ações no mês, em operações comuns, com lucro. Ela paga imposto de renda sobre esse ganho?",
    expectedFacts: [
      { description: "é isento", alternatives: ["isen"] },
      {
        description: "limite de R$ 20.000/mês",
        alternatives: ["20.000", "20 mil", "20000", "vinte mil"],
      },
    ],
    forbidden: [],
    reference: "IN RFB 1585/2015, art. 59 (vendas até R$ 20.000/mês em operações comuns)",
  },
  {
    id: "acoes-aliquota-swing",
    category: "tributacao",
    difficulty: "easy",
    question:
      "Qual a alíquota de IR sobre o ganho líquido de pessoa física em operações comuns (swing trade) com ações, acima do limite de isenção?",
    expectedFacts: [{ description: "alíquota de 15%", alternatives: ["15%", "15 %"] }],
    forbidden: [
      {
        description: "confusão com a tabela progressiva (27,5%)",
        alternatives: ["27.5%", "27.5 %"],
      },
    ],
    reference: "Lei 11.033/2004, art. 2º",
  },
  {
    id: "day-trade",
    category: "tributacao",
    difficulty: "medium",
    question: "Como é tributado o day trade em ações para pessoa física?",
    expectedFacts: [
      { description: "alíquota de 20%", alternatives: ["20%", "20 %"] },
      { description: "retenção de 1% na fonte (dedo-duro)", alternatives: ["1%", "1 %"] },
    ],
    forbidden: [],
    reference: "Lei 11.033/2004; IN RFB 1585/2015 (retenção na fonte em day trade)",
  },
  {
    id: "come-cotas",
    category: "tributacao",
    difficulty: "medium",
    question: "O que é o come-cotas de fundos de investimento e quando ele ocorre?",
    expectedFacts: [
      {
        description: "antecipação/recolhimento periódico de IR",
        alternatives: ["antecipa", "recolhimento", "semestral"],
      },
      { description: "ocorre em maio", alternatives: ["maio"] },
      { description: "ocorre em novembro", alternatives: ["novembro"] },
    ],
    forbidden: [],
    reference: "Lei 14.754/2023 (regime atual do come-cotas em fundos abertos)",
  },
  {
    id: "renda-fixa-tabela-regressiva",
    category: "tributacao",
    difficulty: "easy",
    question:
      "Quais são as alíquotas da tabela regressiva de IR para renda fixa (CDB, Tesouro Direto) conforme o prazo da aplicação?",
    expectedFacts: [
      { description: "22,5% até 180 dias", alternatives: ["22.5"] },
      { description: "20% de 181 a 360 dias", alternatives: ["20"] },
      { description: "17,5% de 361 a 720 dias", alternatives: ["17.5"] },
      { description: "15% acima de 720 dias", alternatives: ["15"] },
    ],
    forbidden: [],
    reference: "Lei 11.033/2004, art. 1º",
  },
  {
    id: "fii-rendimentos",
    category: "tributacao",
    difficulty: "hard",
    question:
      "Os rendimentos mensais distribuídos por FIIs são isentos de IR para pessoa física? Em quais condições?",
    expectedFacts: [
      { description: "há isenção", alternatives: ["isen"] },
      { description: "fundo com no mínimo 50 cotistas", alternatives: ["50"] },
      {
        description: "cotas negociadas em bolsa/balcão",
        alternatives: ["bolsa", "balcão", "negociad"],
      },
      { description: "cotista com menos de 10% das cotas", alternatives: ["10%", "10 %"] },
    ],
    forbidden: [],
    reference: "Lei 11.196/2005, art. 3º, III (rendimentos de FII para PF)",
  },
  {
    id: "lci-lca",
    category: "tributacao",
    difficulty: "easy",
    question: "LCI e LCA pagam imposto de renda para pessoa física?",
    expectedFacts: [{ description: "são isentas para PF", alternatives: ["isen"] }],
    forbidden: [],
    reference: "Lei 11.033/2004, art. 3º",
  },
  {
    id: "debentures-incentivadas",
    category: "tributacao",
    difficulty: "medium",
    question:
      "Como são tributados, para pessoa física, os rendimentos de debêntures incentivadas de infraestrutura?",
    expectedFacts: [
      { description: "isentos para PF", alternatives: ["isen"] },
      {
        description: "base legal Lei 12.431 / debênture incentivada",
        alternatives: ["12.431", "incentivad"],
      },
    ],
    forbidden: [],
    reference: "Lei 12.431/2011, art. 2º",
  },
  {
    id: "jcp",
    category: "tributacao",
    difficulty: "medium",
    question:
      "Como são tributados os Juros sobre Capital Próprio (JCP) recebidos por pessoa física?",
    expectedFacts: [
      { description: "alíquota de 15%", alternatives: ["15%", "15 %"] },
      { description: "retenção exclusiva na fonte", alternatives: ["fonte", "retid", "retenç"] },
    ],
    forbidden: [],
    reference: "Lei 9.249/1995, art. 9º, §2º",
  },
  {
    id: "pgbl-deducao",
    category: "tributacao",
    difficulty: "medium",
    question: "Qual o benefício fiscal do PGBL para quem entrega a declaração completa do IR?",
    expectedFacts: [
      { description: "dedução da base de cálculo", alternatives: ["dedu"] },
      {
        description: "limite de 12% da renda bruta anual tributável",
        alternatives: ["12%", "12 %"],
      },
    ],
    forbidden: [],
    reference: "Lei 9.532/1997, art. 11",
  },
  {
    id: "previdencia-regressiva-10",
    category: "tributacao",
    difficulty: "medium",
    question:
      "Na tabela regressiva da previdência privada, qual é a menor alíquota de IR e a partir de qual prazo de acumulação ela vale?",
    expectedFacts: [
      { description: "alíquota mínima de 10%", alternatives: ["10%", "10 %"] },
      { description: "a partir de 10 anos", alternatives: ["10 anos", "dez anos"] },
    ],
    forbidden: [],
    reference: "Lei 11.053/2004, art. 1º",
  },
  {
    id: "iof-renda-fixa",
    category: "tributacao",
    difficulty: "easy",
    question: "Quando incide IOF sobre o resgate de uma aplicação de renda fixa?",
    expectedFacts: [
      { description: "resgates antes de 30 dias", alternatives: ["30 dias", "trinta dias"] },
      { description: "tabela regressiva do IOF (96% → 0%)", alternatives: ["regress", "96"] },
    ],
    forbidden: [],
    reference: "Decreto 6.306/2007 (tabela regressiva de IOF)",
  },
  {
    id: "fgc-cobertura",
    category: "produtos",
    difficulty: "medium",
    question:
      "Qual é a cobertura do FGC (Fundo Garantidor de Créditos) por investidor pessoa física?",
    expectedFacts: [
      { description: "R$ 250 mil por CPF por instituição/conglomerado", alternatives: ["250"] },
      {
        description: "teto global de R$ 1 milhão",
        alternatives: ["1 milhão", "1.000.000", "um milhão"],
      },
      {
        description: "janela de 4 anos para o teto global",
        alternatives: ["4 anos", "quatro anos"],
      },
    ],
    forbidden: [],
    reference: "Regulamento do FGC (Resolução CMN 4.222/2013 e alterações)",
  },
  {
    id: "poupanca-rendimento",
    category: "produtos",
    difficulty: "medium",
    question: "Como rende a caderneta de poupança quando a Selic está ACIMA de 8,5% ao ano?",
    expectedFacts: [
      { description: "0,5% ao mês", alternatives: ["0.5%", "0.5 %"] },
      { description: "mais TR (taxa referencial)", alternatives: ["tr", "taxa referencial"] },
    ],
    forbidden: [],
    reference: "Lei 12.703/2012 (regra da poupança pós-2012)",
  },
  {
    id: "suitability",
    category: "cvm",
    difficulty: "hard",
    question:
      "O que a regulação da CVM exige verificar antes de recomendar produtos de investimento a um cliente, e qual norma trata disso?",
    expectedFacts: [
      {
        description: "adequação ao perfil (suitability)",
        alternatives: ["suitability", "adequação", "perfil"],
      },
      {
        description: "Resolução CVM 30",
        alternatives: ["cvm 30", "resolução 30", "icvm 539", "instrução 539"],
      },
    ],
    forbidden: [],
    reference: "Resolução CVM 30/2021 (sucessora da ICVM 539)",
  },
  {
    id: "consultoria-registro",
    category: "cvm",
    difficulty: "medium",
    question:
      "É preciso autorização para atuar profissionalmente como consultor de valores mobiliários no Brasil?",
    expectedFacts: [
      {
        description: "exige registro/credenciamento",
        alternatives: ["registro", "autorização", "credenciamento"],
      },
      { description: "perante a CVM", alternatives: ["cvm"] },
    ],
    forbidden: [],
    reference: "Resolução CVM 19/2021 (consultores de valores mobiliários)",
  },
  {
    id: "fundos-resolucao-175",
    category: "cvm",
    difficulty: "hard",
    question:
      "Qual resolução da CVM é o marco regulatório vigente dos fundos de investimento no Brasil?",
    expectedFacts: [{ description: "Resolução CVM 175", alternatives: ["175"] }],
    forbidden: [],
    reference: "Resolução CVM 175/2022",
  },
  {
    id: "open-finance-consentimento",
    category: "open_finance",
    difficulty: "medium",
    question:
      "O que o Open Finance brasileiro exige do cliente para que seus dados sejam compartilhados entre instituições, e por quanto tempo vale?",
    expectedFacts: [
      { description: "consentimento expresso do cliente", alternatives: ["consentimento"] },
      {
        description: "validade limitada (até 12 meses, renovável)",
        alternatives: ["12 meses", "doze meses", "prazo", "validade"],
      },
    ],
    forbidden: [],
    reference: "Resolução Conjunta CMN/BCB 1/2020 (Open Finance)",
  },
  {
    id: "ptax",
    category: "macro",
    difficulty: "easy",
    question: "O que é a taxa PTAX e quem a divulga?",
    expectedFacts: [
      {
        description: "taxa de câmbio (referência do dólar)",
        alternatives: ["câmbio", "dólar", "dolar"],
      },
      {
        description: "calculada/divulgada pelo Banco Central",
        alternatives: ["banco central", "bacen", "bcb"],
      },
    ],
    forbidden: [],
    reference: "Circular BCB 3.506/2010 (metodologia da PTAX)",
  },
  {
    id: "copom-selic",
    category: "macro",
    difficulty: "easy",
    question: "Quem define a taxa Selic e com qual frequência isso acontece?",
    expectedFacts: [
      { description: "definida pelo Copom", alternatives: ["copom"] },
      {
        description: "a cada 45 dias (8 reuniões/ano)",
        alternatives: ["45 dias", "oito reuni", "8 reuni"],
      },
    ],
    forbidden: [],
    reference: "Regimento do Copom (BCB)",
  },
  {
    id: "darf-acoes-prazo",
    category: "tributacao",
    difficulty: "medium",
    question: "Como e até quando a pessoa física recolhe o IR devido sobre ganhos com ações?",
    expectedFacts: [
      { description: "recolhimento via DARF", alternatives: ["darf"] },
      {
        description: "até o último dia útil do mês seguinte",
        alternatives: ["mês seguinte", "mes seguinte", "mês subsequente", "mes subsequente"],
      },
    ],
    forbidden: [],
    reference: "IN RFB 1585/2015 (apuração mensal e recolhimento por DARF, código 6015)",
  },
  {
    id: "dedo-duro-swing",
    category: "tributacao",
    difficulty: "hard",
    question:
      "Qual é a alíquota do IR retido na fonte (o 'dedo-duro') em operações comuns de bolsa, e para que ele serve?",
    expectedFacts: [
      { description: "0,005% sobre a alienação", alternatives: ["0.005"] },
      {
        description: "informar a Receita / antecipar o controle das operações",
        alternatives: ["receita", "fiscaliza", "informar", "antecip"],
      },
    ],
    forbidden: [],
    reference: "Lei 11.033/2004, art. 2º, §1º (IRRF 0,005% em operações comuns)",
  },
  {
    id: "compensacao-prejuizos",
    category: "tributacao",
    difficulty: "medium",
    question:
      "Prejuízos em operações com ações podem ser compensados com ganhos futuros? Há alguma restrição?",
    expectedFacts: [
      { description: "podem ser compensados, sem prazo", alternatives: ["compensa"] },
      {
        description: "respeitando a modalidade (day trade só com day trade)",
        alternatives: ["modalidade", "day trade", "day-trade", "mesma natureza"],
      },
    ],
    forbidden: [],
    reference: "IN RFB 1585/2015, art. 64 (compensação de perdas por modalidade)",
  },
  {
    id: "fii-venda-cotas",
    category: "tributacao",
    difficulty: "medium",
    question:
      "Qual a alíquota de IR sobre o ganho de capital na VENDA de cotas de FII por pessoa física, e existe isenção mensal como nas ações?",
    expectedFacts: [
      { description: "alíquota de 20%", alternatives: ["20%", "20 %"] },
      {
        description: "não há a isenção de R$ 20 mil para FII",
        alternatives: [
          "não se aplica",
          "nao se aplica",
          "não há isenção",
          "nao ha isencao",
          "sem isenção",
          "sem isencao",
          "não vale",
          "nao vale",
        ],
      },
    ],
    forbidden: [],
    reference: "Lei 8.668/1993, art. 18 (ganho de capital em FII: 20%, sem isenção mensal)",
  },
  {
    id: "bdr-sem-isencao",
    category: "tributacao",
    difficulty: "hard",
    question: "A isenção mensal de R$ 20.000 para vendas de ações vale também para BDRs?",
    expectedFacts: [
      {
        description: "não se aplica a BDRs (restrita a ações)",
        alternatives: [
          "não se aplica",
          "nao se aplica",
          "não vale",
          "nao vale",
          "não há isenção",
          "nao ha isencao",
          "sem isenção",
          "sem isencao",
          "apenas a ações",
          "apenas a acoes",
          "restrita a ações",
          "restrita a acoes",
        ],
      },
    ],
    forbidden: [],
    reference: "IN RFB 1585/2015 (isenção do art. 59 restrita a ações no mercado à vista)",
  },
  {
    id: "come-cotas-aliquotas",
    category: "tributacao",
    difficulty: "medium",
    question: "Quais alíquotas o come-cotas usa em fundos de longo e de curto prazo?",
    expectedFacts: [
      { description: "15% em fundos de longo prazo", alternatives: ["15"] },
      { description: "20% em fundos de curto prazo", alternatives: ["20"] },
    ],
    forbidden: [],
    reference: "Lei 14.754/2023 (alíquotas do come-cotas por classificação do fundo)",
  },
  {
    id: "fundos-curto-longo-prazo",
    category: "tributacao",
    difficulty: "hard",
    question: "O que diferencia um fundo de CURTO prazo de um de LONGO prazo para fins de IR?",
    expectedFacts: [{ description: "prazo médio da carteira de 365 dias", alternatives: ["365"] }],
    forbidden: [],
    reference: "IN RFB 1585/2015, art. 3º (carteira com prazo médio ≤ 365 dias = curto prazo)",
  },
  {
    id: "previdencia-escolha-tabela",
    category: "tributacao",
    difficulty: "hard",
    question:
      "Quando o participante de previdência privada escolhe entre a tabela progressiva e a regressiva?",
    expectedFacts: [
      {
        description: "a opção pode ser feita no momento do resgate/benefício",
        alternatives: ["resgate", "benefício", "beneficio", "momento"],
      },
    ],
    forbidden: [],
    reference: "Lei 14.803/2024 (opção pelo regime de tributação no resgate/benefício)",
  },
  {
    id: "vgbl-base-ir",
    category: "tributacao",
    difficulty: "medium",
    question: "No resgate, qual a diferença da base de cálculo do IR entre VGBL e PGBL?",
    expectedFacts: [
      { description: "no VGBL o IR incide só sobre os rendimentos", alternatives: ["rendimento"] },
      {
        description: "no PGBL incide sobre o valor total resgatado",
        alternatives: ["total", "todo o valor", "valor integral"],
      },
    ],
    forbidden: [],
    reference: "Lei 11.053/2004 (regimes de tributação de PGBL/VGBL)",
  },
  {
    id: "assessor-investimentos",
    category: "cvm",
    difficulty: "hard",
    question:
      "Qual resolução da CVM rege a atividade de assessor de investimentos (antigo agente autônomo)?",
    expectedFacts: [{ description: "Resolução CVM 178", alternatives: ["178"] }],
    forbidden: [],
    reference: "Resolução CVM 178/2023",
  },
  {
    id: "insider-trading",
    category: "cvm",
    difficulty: "medium",
    question:
      "Negociar valores mobiliários usando informação relevante ainda não divulgada ao mercado tem qual consequência legal no Brasil?",
    expectedFacts: [
      {
        description: "é crime (uso indevido de informação privilegiada)",
        alternatives: ["crime", "ilícit", "ilicit"],
      },
      { description: "informação privilegiada/insider", alternatives: ["privilegiada", "insider"] },
    ],
    forbidden: [],
    reference: "Lei 6.385/1976, art. 27-D (crime de uso indevido de informação privilegiada)",
  },
  {
    id: "ofertas-publicas",
    category: "cvm",
    difficulty: "hard",
    question:
      "Qual resolução da CVM rege atualmente as ofertas públicas de distribuição de valores mobiliários?",
    expectedFacts: [{ description: "Resolução CVM 160", alternatives: ["160"] }],
    forbidden: [],
    reference: "Resolução CVM 160/2022 (substituiu as ICVM 400 e 476)",
  },
  {
    id: "crowdfunding",
    category: "cvm",
    difficulty: "hard",
    question:
      "Qual resolução da CVM regula o investimento via plataformas de crowdfunding no Brasil?",
    expectedFacts: [{ description: "Resolução CVM 88", alternatives: ["88"] }],
    forbidden: [],
    reference: "Resolução CVM 88/2022 (crowdfunding de investimento)",
  },
  {
    id: "open-finance-itp",
    category: "open_finance",
    difficulty: "medium",
    question:
      "O que faz um Iniciador de Transação de Pagamento (ITP) no ecossistema do Open Finance?",
    expectedFacts: [
      { description: "inicia pagamentos em nome do cliente", alternatives: ["inicia"] },
      {
        description: "sem detenção da conta do cliente",
        alternatives: ["sem ser", "sem deter", "não detém", "nao detem", "conta"],
      },
    ],
    forbidden: [],
    reference: "Resolução BCB 80/2021 (instituições de pagamento; modalidade ITP)",
  },
  {
    id: "open-finance-participacao",
    category: "open_finance",
    difficulty: "hard",
    question: "A participação no Open Finance é obrigatória para quais instituições?",
    expectedFacts: [
      { description: "obrigatória para as grandes (S1 e S2)", alternatives: ["obrigat"] },
      { description: "segmentos S1/S2", alternatives: ["s1", "s2", "grande", "porte"] },
    ],
    forbidden: [],
    reference: "Resolução Conjunta CMN/BCB 1/2020 (escopo obrigatório para S1/S2)",
  },
  {
    id: "tesouro-direto-titulos",
    category: "produtos",
    difficulty: "easy",
    question: "Quais são os três tipos básicos de títulos do Tesouro Direto?",
    expectedFacts: [
      { description: "Tesouro Selic (pós-fixado)", alternatives: ["selic"] },
      { description: "Tesouro Prefixado", alternatives: ["prefixado"] },
      { description: "Tesouro IPCA+ (híbrido)", alternatives: ["ipca"] },
    ],
    forbidden: [],
    reference: "Programa Tesouro Direto (Tesouro Nacional/B3)",
  },
  {
    id: "tesouro-custodia-b3",
    category: "produtos",
    difficulty: "hard",
    question:
      "Qual a taxa de custódia da B3 no Tesouro Direto e qual a isenção para o Tesouro Selic?",
    expectedFacts: [
      { description: "0,20% ao ano", alternatives: ["0.2"] },
      {
        description: "isenção até R$ 10 mil em Tesouro Selic",
        alternatives: ["10.000", "10 mil", "10000", "dez mil"],
      },
    ],
    forbidden: [],
    reference: "Regulamento do Tesouro Direto (B3) — custódia 0,20% a.a.",
  },
  {
    id: "cri-cra",
    category: "produtos",
    difficulty: "medium",
    question: "CRI e CRA são isentos de IR para pessoa física? E contam com a garantia do FGC?",
    expectedFacts: [
      { description: "isentos de IR para PF", alternatives: ["isen"] },
      {
        description: "não contam com FGC",
        alternatives: [
          "sem fgc",
          "não tem fgc",
          "nao tem fgc",
          "não contam",
          "nao contam",
          "não são cobertos",
          "nao sao cobertos",
          "não possuem",
          "nao possuem",
          "não há fgc",
          "nao ha fgc",
        ],
      },
    ],
    forbidden: [],
    reference: "Lei 11.033/2004, art. 3º (isenção); regulamento do FGC (sem cobertura)",
  },
  {
    id: "fgc-produtos",
    category: "produtos",
    difficulty: "medium",
    question: "Entre CDB, LCI e debênture, quais contam com a garantia do FGC?",
    expectedFacts: [
      { description: "CDB tem FGC", alternatives: ["cdb"] },
      { description: "LCI tem FGC", alternatives: ["lci"] },
      {
        description: "debênture fica de fora",
        alternatives: [
          "debênture não",
          "debenture nao",
          "debênture fica de fora",
          "debenture fica de fora",
          "exceto a debênture",
          "exceto a debenture",
          "debêntures não",
          "debentures nao",
        ],
      },
    ],
    forbidden: [],
    reference: "Regulamento do FGC (instrumentos elegíveis)",
  },
  {
    id: "ipca-ibge",
    category: "macro",
    difficulty: "easy",
    question: "O que é o IPCA e quem o calcula?",
    expectedFacts: [
      {
        description: "índice oficial de inflação (preços ao consumidor)",
        alternatives: ["inflação", "inflacao", "preços", "precos"],
      },
      { description: "calculado pelo IBGE", alternatives: ["ibge"] },
    ],
    forbidden: [],
    reference: "IBGE (Sistema Nacional de Índices de Preços ao Consumidor)",
  },
  {
    id: "cdi-definicao",
    category: "macro",
    difficulty: "medium",
    question: "O que é o CDI e quem calcula/divulga essa taxa?",
    expectedFacts: [
      {
        description: "taxa dos depósitos interfinanceiros/interbancários",
        alternatives: ["interfinanceir", "interbancár", "interbancar", "entre bancos"],
      },
      { description: "calculada pela B3 (antiga Cetip)", alternatives: ["b3", "cetip"] },
    ],
    forbidden: [],
    reference: "Metodologia da Taxa DI (B3)",
  },
  {
    id: "meta-inflacao",
    category: "macro",
    difficulty: "medium",
    question: "Quem define a meta de inflação do Brasil e qual é a meta vigente?",
    expectedFacts: [
      {
        description: "definida pelo CMN",
        alternatives: ["cmn", "conselho monetário", "conselho monetario"],
      },
      { description: "meta de 3% (com banda de tolerância)", alternatives: ["3%", "3 %", "3.0"] },
    ],
    forbidden: [],
    reference: "Decreto 11.617/2023 (meta contínua de 3,0% ± 1,5 p.p.)",
  },
];
