"""Dataset curado do SEAL BR — perguntas financeiras brasileiras com gabarito.

É exatamente o conhecimento que ``docs/B2B.md`` cita como inviável em datasets
globais: isenção de R$20K em ações, come-cotas, tributação de FII, debêntures
incentivadas, PTAX, suitability CVM, consentimento do Open Finance.

Regras de curadoria:
  * Alternativas cobrem grafias usuais (``22,5%`` vira ``22.5%`` na
    normalização; "20 mil" e "20.000" são alternativas explícitas).
  * ``forbidden`` só carrega erros clássicos que uma resposta CORRETA não
    citaria (ex.: 27,5% da tabela progressiva em ganho de ações) — proibição
    agressiva geraria falso negativo em respostas que contrastam regimes.
  * ``reference`` é a fonte normativa; nunca sai no catálogo público.
"""

from __future__ import annotations

from carina.data_engine.evaluation import EvalCase, EvalCategory, ExpectedFact

_T = EvalCategory.TRIBUTACAO
_C = EvalCategory.CVM
_OF = EvalCategory.OPEN_FINANCE
_P = EvalCategory.PRODUTOS
_M = EvalCategory.MACRO


def _fact(description: str, *alternatives: str) -> ExpectedFact:
    return ExpectedFact(description=description, alternatives=list(alternatives))


DATASET: list[EvalCase] = [
    # ── Tributação ───────────────────────────────────────────────────────────
    EvalCase(
        id="acoes-isencao-20k",
        category=_T,
        difficulty="easy",
        question=(
            "Uma pessoa física vendeu R$ 18.000 em ações no mês, em operações comuns, "
            "com lucro. Ela paga imposto de renda sobre esse ganho?"
        ),
        expected_facts=[
            _fact("é isento", "isen"),
            _fact("limite de R$ 20.000/mês", "20.000", "20 mil", "20000", "vinte mil"),
        ],
        reference="IN RFB 1585/2015, art. 59 (vendas até R$ 20.000/mês em operações comuns)",
    ),
    EvalCase(
        id="acoes-aliquota-swing",
        category=_T,
        difficulty="easy",
        question=(
            "Qual a alíquota de IR sobre o ganho líquido de pessoa física em operações "
            "comuns (swing trade) com ações, acima do limite de isenção?"
        ),
        expected_facts=[_fact("alíquota de 15%", "15%", "15 %")],
        forbidden=[_fact("confusão com a tabela progressiva (27,5%)", "27.5%", "27.5 %")],
        reference="Lei 11.033/2004, art. 2º",
    ),
    EvalCase(
        id="day-trade",
        category=_T,
        difficulty="medium",
        question="Como é tributado o day trade em ações para pessoa física?",
        expected_facts=[
            _fact("alíquota de 20%", "20%", "20 %"),
            _fact("retenção de 1% na fonte (dedo-duro)", "1%", "1 %"),
        ],
        reference="Lei 11.033/2004; IN RFB 1585/2015 (retenção na fonte em day trade)",
    ),
    EvalCase(
        id="come-cotas",
        category=_T,
        difficulty="medium",
        question="O que é o come-cotas de fundos de investimento e quando ele ocorre?",
        expected_facts=[
            _fact(
                "antecipação/recolhimento periódico de IR", "antecipa", "recolhimento", "semestral"
            ),
            _fact("ocorre em maio", "maio"),
            _fact("ocorre em novembro", "novembro"),
        ],
        reference="Lei 14.754/2023 (regime atual do come-cotas em fundos abertos)",
    ),
    EvalCase(
        id="renda-fixa-tabela-regressiva",
        category=_T,
        difficulty="easy",
        question=(
            "Quais são as alíquotas da tabela regressiva de IR para renda fixa "
            "(CDB, Tesouro Direto) conforme o prazo da aplicação?"
        ),
        expected_facts=[
            _fact("22,5% até 180 dias", "22.5"),
            _fact("20% de 181 a 360 dias", "20"),
            _fact("17,5% de 361 a 720 dias", "17.5"),
            _fact("15% acima de 720 dias", "15"),
        ],
        reference="Lei 11.033/2004, art. 1º",
    ),
    EvalCase(
        id="fii-rendimentos",
        category=_T,
        difficulty="hard",
        question=(
            "Os rendimentos mensais distribuídos por FIIs são isentos de IR para "
            "pessoa física? Em quais condições?"
        ),
        expected_facts=[
            _fact("há isenção", "isen"),
            _fact("fundo com no mínimo 50 cotistas", "50"),
            _fact("cotas negociadas em bolsa/balcão", "bolsa", "balcão", "negociad"),
            _fact("cotista com menos de 10% das cotas", "10%", "10 %"),
        ],
        reference="Lei 11.196/2005, art. 3º, III (rendimentos de FII para PF)",
    ),
    EvalCase(
        id="lci-lca",
        category=_T,
        difficulty="easy",
        question="LCI e LCA pagam imposto de renda para pessoa física?",
        expected_facts=[_fact("são isentas para PF", "isen")],
        reference="Lei 11.033/2004, art. 3º",
    ),
    EvalCase(
        id="debentures-incentivadas",
        category=_T,
        difficulty="medium",
        question=(
            "Como são tributados, para pessoa física, os rendimentos de debêntures "
            "incentivadas de infraestrutura?"
        ),
        expected_facts=[
            _fact("isentos para PF", "isen"),
            _fact("base legal Lei 12.431 / debênture incentivada", "12.431", "incentivad"),
        ],
        reference="Lei 12.431/2011, art. 2º",
    ),
    EvalCase(
        id="jcp",
        category=_T,
        difficulty="medium",
        question=(
            "Como são tributados os Juros sobre Capital Próprio (JCP) recebidos "
            "por pessoa física?"
        ),
        expected_facts=[
            _fact("alíquota de 15%", "15%", "15 %"),
            _fact("retenção exclusiva na fonte", "fonte", "retid", "retenç"),
        ],
        reference="Lei 9.249/1995, art. 9º, §2º",
    ),
    EvalCase(
        id="pgbl-deducao",
        category=_T,
        difficulty="medium",
        question=(
            "Qual o benefício fiscal do PGBL para quem entrega a declaração " "completa do IR?"
        ),
        expected_facts=[
            _fact("dedução da base de cálculo", "dedu"),
            _fact("limite de 12% da renda bruta anual tributável", "12%", "12 %"),
        ],
        reference="Lei 9.532/1997, art. 11",
    ),
    EvalCase(
        id="previdencia-regressiva-10",
        category=_T,
        difficulty="medium",
        question=(
            "Na tabela regressiva da previdência privada, qual é a menor alíquota "
            "de IR e a partir de qual prazo de acumulação ela vale?"
        ),
        expected_facts=[
            _fact("alíquota mínima de 10%", "10%", "10 %"),
            _fact("a partir de 10 anos", "10 anos", "dez anos"),
        ],
        reference="Lei 11.053/2004, art. 1º",
    ),
    EvalCase(
        id="iof-renda-fixa",
        category=_T,
        difficulty="easy",
        question="Quando incide IOF sobre o resgate de uma aplicação de renda fixa?",
        expected_facts=[
            _fact("resgates antes de 30 dias", "30 dias", "trinta dias"),
            _fact("tabela regressiva do IOF (96% → 0%)", "regress", "96"),
        ],
        reference="Decreto 6.306/2007 (tabela regressiva de IOF)",
    ),
    # ── Produtos ─────────────────────────────────────────────────────────────
    EvalCase(
        id="fgc-cobertura",
        category=_P,
        difficulty="medium",
        question=(
            "Qual é a cobertura do FGC (Fundo Garantidor de Créditos) por investidor "
            "pessoa física?"
        ),
        expected_facts=[
            _fact("R$ 250 mil por CPF por instituição/conglomerado", "250"),
            _fact("teto global de R$ 1 milhão", "1 milhão", "1.000.000", "um milhão"),
            _fact("janela de 4 anos para o teto global", "4 anos", "quatro anos"),
        ],
        reference="Regulamento do FGC (Resolução CMN 4.222/2013 e alterações)",
    ),
    EvalCase(
        id="poupanca-rendimento",
        category=_P,
        difficulty="medium",
        question=(
            "Como rende a caderneta de poupança quando a Selic está ACIMA de " "8,5% ao ano?"
        ),
        expected_facts=[
            _fact("0,5% ao mês", "0.5%", "0.5 %"),
            _fact("mais TR (taxa referencial)", "tr", "taxa referencial"),
        ],
        reference="Lei 12.703/2012 (regra da poupança pós-2012)",
    ),
    # ── CVM ──────────────────────────────────────────────────────────────────
    EvalCase(
        id="suitability",
        category=_C,
        difficulty="hard",
        question=(
            "O que a regulação da CVM exige verificar antes de recomendar produtos "
            "de investimento a um cliente, e qual norma trata disso?"
        ),
        expected_facts=[
            _fact("adequação ao perfil (suitability)", "suitability", "adequação", "perfil"),
            _fact("Resolução CVM 30", "cvm 30", "resolução 30", "icvm 539", "instrução 539"),
        ],
        reference="Resolução CVM 30/2021 (sucessora da ICVM 539)",
    ),
    EvalCase(
        id="consultoria-registro",
        category=_C,
        difficulty="medium",
        question=(
            "É preciso autorização para atuar profissionalmente como consultor de "
            "valores mobiliários no Brasil?"
        ),
        expected_facts=[
            _fact("exige registro/credenciamento", "registro", "autorização", "credenciamento"),
            _fact("perante a CVM", "cvm"),
        ],
        reference="Resolução CVM 19/2021 (consultores de valores mobiliários)",
    ),
    EvalCase(
        id="fundos-resolucao-175",
        category=_C,
        difficulty="hard",
        question=(
            "Qual resolução da CVM é o marco regulatório vigente dos fundos de "
            "investimento no Brasil?"
        ),
        expected_facts=[_fact("Resolução CVM 175", "175")],
        reference="Resolução CVM 175/2022",
    ),
    # ── Open Finance ─────────────────────────────────────────────────────────
    EvalCase(
        id="open-finance-consentimento",
        category=_OF,
        difficulty="medium",
        question=(
            "O que o Open Finance brasileiro exige do cliente para que seus dados "
            "sejam compartilhados entre instituições, e por quanto tempo vale?"
        ),
        expected_facts=[
            _fact("consentimento expresso do cliente", "consentimento"),
            _fact(
                "validade limitada (até 12 meses, renovável)",
                "12 meses",
                "doze meses",
                "prazo",
                "validade",
            ),
        ],
        reference="Resolução Conjunta CMN/BCB 1/2020 (Open Finance)",
    ),
    # ── Macro ────────────────────────────────────────────────────────────────
    EvalCase(
        id="ptax",
        category=_M,
        difficulty="easy",
        question="O que é a taxa PTAX e quem a divulga?",
        expected_facts=[
            _fact("taxa de câmbio (referência do dólar)", "câmbio", "dólar", "dolar"),
            _fact("calculada/divulgada pelo Banco Central", "banco central", "bacen", "bcb"),
        ],
        reference="Circular BCB 3.506/2010 (metodologia da PTAX)",
    ),
    EvalCase(
        id="copom-selic",
        category=_M,
        difficulty="easy",
        question="Quem define a taxa Selic e com qual frequência isso acontece?",
        expected_facts=[
            _fact("definida pelo Copom", "copom"),
            _fact("a cada 45 dias (8 reuniões/ano)", "45 dias", "oito reuni", "8 reuni"),
        ],
        reference="Regimento do Copom (BCB)",
    ),
    # ── Tributação (expansão) ────────────────────────────────────────────────
    EvalCase(
        id="darf-acoes-prazo",
        category=_T,
        difficulty="medium",
        question=(
            "Como e até quando a pessoa física recolhe o IR devido sobre ganhos " "com ações?"
        ),
        expected_facts=[
            _fact("recolhimento via DARF", "darf"),
            _fact(
                "até o último dia útil do mês seguinte",
                "mês seguinte",
                "mes seguinte",
                "mês subsequente",
                "mes subsequente",
            ),
        ],
        reference="IN RFB 1585/2015 (apuração mensal e recolhimento por DARF, código 6015)",
    ),
    EvalCase(
        id="dedo-duro-swing",
        category=_T,
        difficulty="hard",
        question=(
            "Qual é a alíquota do IR retido na fonte (o 'dedo-duro') em operações "
            "comuns de bolsa, e para que ele serve?"
        ),
        expected_facts=[
            _fact("0,005% sobre a alienação", "0.005"),
            _fact(
                "informar a Receita / antecipar o controle das operações",
                "receita",
                "fiscaliza",
                "informar",
                "antecip",
            ),
        ],
        reference="Lei 11.033/2004, art. 2º, §1º (IRRF 0,005% em operações comuns)",
    ),
    EvalCase(
        id="compensacao-prejuizos",
        category=_T,
        difficulty="medium",
        question=(
            "Prejuízos em operações com ações podem ser compensados com ganhos "
            "futuros? Há alguma restrição?"
        ),
        expected_facts=[
            _fact("podem ser compensados, sem prazo", "compensa"),
            _fact(
                "respeitando a modalidade (day trade só com day trade)",
                "modalidade",
                "day trade",
                "day-trade",
                "mesma natureza",
            ),
        ],
        reference="IN RFB 1585/2015, art. 64 (compensação de perdas por modalidade)",
    ),
    EvalCase(
        id="fii-venda-cotas",
        category=_T,
        difficulty="medium",
        question=(
            "Qual a alíquota de IR sobre o ganho de capital na VENDA de cotas de "
            "FII por pessoa física, e existe isenção mensal como nas ações?"
        ),
        expected_facts=[
            _fact("alíquota de 20%", "20%", "20 %"),
            _fact(
                "não há a isenção de R$ 20 mil para FII",
                "não se aplica",
                "nao se aplica",
                "não há isenção",
                "nao ha isencao",
                "sem isenção",
                "sem isencao",
                "não vale",
                "nao vale",
            ),
        ],
        reference="Lei 8.668/1993, art. 18 (ganho de capital em FII: 20%, sem isenção mensal)",
    ),
    EvalCase(
        id="bdr-sem-isencao",
        category=_T,
        difficulty="hard",
        question=("A isenção mensal de R$ 20.000 para vendas de ações vale também para " "BDRs?"),
        expected_facts=[
            _fact(
                "não se aplica a BDRs (restrita a ações)",
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
            ),
        ],
        reference="IN RFB 1585/2015 (isenção do art. 59 restrita a ações no mercado à vista)",
    ),
    EvalCase(
        id="come-cotas-aliquotas",
        category=_T,
        difficulty="medium",
        question="Quais alíquotas o come-cotas usa em fundos de longo e de curto prazo?",
        expected_facts=[
            _fact("15% em fundos de longo prazo", "15"),
            _fact("20% em fundos de curto prazo", "20"),
        ],
        reference="Lei 14.754/2023 (alíquotas do come-cotas por classificação do fundo)",
    ),
    EvalCase(
        id="fundos-curto-longo-prazo",
        category=_T,
        difficulty="hard",
        question=(
            "O que diferencia um fundo de CURTO prazo de um de LONGO prazo para " "fins de IR?"
        ),
        expected_facts=[
            _fact("prazo médio da carteira de 365 dias", "365"),
        ],
        reference="IN RFB 1585/2015, art. 3º (carteira com prazo médio ≤ 365 dias = curto prazo)",
    ),
    EvalCase(
        id="previdencia-escolha-tabela",
        category=_T,
        difficulty="hard",
        question=(
            "Quando o participante de previdência privada escolhe entre a tabela "
            "progressiva e a regressiva?"
        ),
        expected_facts=[
            _fact(
                "a opção pode ser feita no momento do resgate/benefício",
                "resgate",
                "benefício",
                "beneficio",
                "momento",
            ),
        ],
        reference="Lei 14.803/2024 (opção pelo regime de tributação no resgate/benefício)",
    ),
    EvalCase(
        id="vgbl-base-ir",
        category=_T,
        difficulty="medium",
        question=("No resgate, qual a diferença da base de cálculo do IR entre VGBL e " "PGBL?"),
        expected_facts=[
            _fact("no VGBL o IR incide só sobre os rendimentos", "rendimento"),
            _fact(
                "no PGBL incide sobre o valor total resgatado",
                "total",
                "todo o valor",
                "valor integral",
            ),
        ],
        reference="Lei 11.053/2004 (regimes de tributação de PGBL/VGBL)",
    ),
    # ── CVM (expansão) ───────────────────────────────────────────────────────
    EvalCase(
        id="assessor-investimentos",
        category=_C,
        difficulty="hard",
        question=(
            "Qual resolução da CVM rege a atividade de assessor de investimentos "
            "(antigo agente autônomo)?"
        ),
        expected_facts=[_fact("Resolução CVM 178", "178")],
        reference="Resolução CVM 178/2023",
    ),
    EvalCase(
        id="insider-trading",
        category=_C,
        difficulty="medium",
        question=(
            "Negociar valores mobiliários usando informação relevante ainda não "
            "divulgada ao mercado tem qual consequência legal no Brasil?"
        ),
        expected_facts=[
            _fact("é crime (uso indevido de informação privilegiada)", "crime", "ilícit", "ilicit"),
            _fact("informação privilegiada/insider", "privilegiada", "insider"),
        ],
        reference="Lei 6.385/1976, art. 27-D (crime de uso indevido de informação privilegiada)",
    ),
    EvalCase(
        id="ofertas-publicas",
        category=_C,
        difficulty="hard",
        question=(
            "Qual resolução da CVM rege atualmente as ofertas públicas de "
            "distribuição de valores mobiliários?"
        ),
        expected_facts=[_fact("Resolução CVM 160", "160")],
        reference="Resolução CVM 160/2022 (substituiu as ICVM 400 e 476)",
    ),
    EvalCase(
        id="crowdfunding",
        category=_C,
        difficulty="hard",
        question=(
            "Qual resolução da CVM regula o investimento via plataformas de "
            "crowdfunding no Brasil?"
        ),
        expected_facts=[_fact("Resolução CVM 88", "88")],
        reference="Resolução CVM 88/2022 (crowdfunding de investimento)",
    ),
    # ── Open Finance (expansão) ──────────────────────────────────────────────
    EvalCase(
        id="open-finance-itp",
        category=_OF,
        difficulty="medium",
        question=(
            "O que faz um Iniciador de Transação de Pagamento (ITP) no ecossistema "
            "do Open Finance?"
        ),
        expected_facts=[
            _fact("inicia pagamentos em nome do cliente", "inicia"),
            _fact(
                "sem detenção da conta do cliente",
                "sem ser",
                "sem deter",
                "não detém",
                "nao detem",
                "conta",
            ),
        ],
        reference="Resolução BCB 80/2021 (instituições de pagamento; modalidade ITP)",
    ),
    EvalCase(
        id="open-finance-participacao",
        category=_OF,
        difficulty="hard",
        question="A participação no Open Finance é obrigatória para quais instituições?",
        expected_facts=[
            _fact("obrigatória para as grandes (S1 e S2)", "obrigat"),
            _fact("segmentos S1/S2", "s1", "s2", "grande", "porte"),
        ],
        reference="Resolução Conjunta CMN/BCB 1/2020 (escopo obrigatório para S1/S2)",
    ),
    # ── Produtos (expansão) ──────────────────────────────────────────────────
    EvalCase(
        id="tesouro-direto-titulos",
        category=_P,
        difficulty="easy",
        question="Quais são os três tipos básicos de títulos do Tesouro Direto?",
        expected_facts=[
            _fact("Tesouro Selic (pós-fixado)", "selic"),
            _fact("Tesouro Prefixado", "prefixado"),
            _fact("Tesouro IPCA+ (híbrido)", "ipca"),
        ],
        reference="Programa Tesouro Direto (Tesouro Nacional/B3)",
    ),
    EvalCase(
        id="tesouro-custodia-b3",
        category=_P,
        difficulty="hard",
        question=(
            "Qual a taxa de custódia da B3 no Tesouro Direto e qual a isenção "
            "para o Tesouro Selic?"
        ),
        expected_facts=[
            _fact("0,20% ao ano", "0.2"),
            _fact("isenção até R$ 10 mil em Tesouro Selic", "10.000", "10 mil", "10000", "dez mil"),
        ],
        reference="Regulamento do Tesouro Direto (B3) — custódia 0,20% a.a.",
    ),
    EvalCase(
        id="cri-cra",
        category=_P,
        difficulty="medium",
        question=(
            "CRI e CRA são isentos de IR para pessoa física? E contam com a " "garantia do FGC?"
        ),
        expected_facts=[
            _fact("isentos de IR para PF", "isen"),
            _fact(
                "não contam com FGC",
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
            ),
        ],
        reference="Lei 11.033/2004, art. 3º (isenção); regulamento do FGC (sem cobertura)",
    ),
    EvalCase(
        id="fgc-produtos",
        category=_P,
        difficulty="medium",
        question=("Entre CDB, LCI e debênture, quais contam com a garantia do FGC?"),
        expected_facts=[
            _fact("CDB tem FGC", "cdb"),
            _fact("LCI tem FGC", "lci"),
            _fact(
                "debênture fica de fora",
                "debênture não",
                "debenture nao",
                "debênture fica de fora",
                "debenture fica de fora",
                "exceto a debênture",
                "exceto a debenture",
                "debêntures não",
                "debentures nao",
            ),
        ],
        reference="Regulamento do FGC (instrumentos elegíveis)",
    ),
    # ── Macro (expansão) ─────────────────────────────────────────────────────
    EvalCase(
        id="ipca-ibge",
        category=_M,
        difficulty="easy",
        question="O que é o IPCA e quem o calcula?",
        expected_facts=[
            _fact(
                "índice oficial de inflação (preços ao consumidor)",
                "inflação",
                "inflacao",
                "preços",
                "precos",
            ),
            _fact("calculado pelo IBGE", "ibge"),
        ],
        reference="IBGE (Sistema Nacional de Índices de Preços ao Consumidor)",
    ),
    EvalCase(
        id="cdi-definicao",
        category=_M,
        difficulty="medium",
        question="O que é o CDI e quem calcula/divulga essa taxa?",
        expected_facts=[
            _fact(
                "taxa dos depósitos interfinanceiros/interbancários",
                "interfinanceir",
                "interbancár",
                "interbancar",
                "entre bancos",
            ),
            _fact("calculada pela B3 (antiga Cetip)", "b3", "cetip"),
        ],
        reference="Metodologia da Taxa DI (B3)",
    ),
    EvalCase(
        id="meta-inflacao",
        category=_M,
        difficulty="medium",
        question=("Quem define a meta de inflação do Brasil e qual é a meta vigente?"),
        expected_facts=[
            _fact("definida pelo CMN", "cmn", "conselho monetário", "conselho monetario"),
            _fact("meta de 3% (com banda de tolerância)", "3%", "3 %", "3.0"),
        ],
        reference="Decreto 11.617/2023 (meta contínua de 3,0% ± 1,5 p.p.)",
    ),
]
