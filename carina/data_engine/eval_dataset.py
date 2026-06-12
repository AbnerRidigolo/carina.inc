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
]
