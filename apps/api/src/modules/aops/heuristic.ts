/**
 * Compilação de um AOP por palavras-chave: a contingência quando o modelo falha (porte de
 * `_heuristic_compile` do Python). Devolve `agents: []` quando nada casa; recusar isso é trabalho do
 * compilador, não daqui.
 *
 * Palavras do Python, com os limites de palavra da heurística do chat onde o termo é curto ou
 * ambíguo (o "ir " do Python casava dentro de "conseguir", "var" dentro de "variação", "meta" dentro
 * de "metamorfose"). O `monitor` do Python não existe aqui e `tax_optimizer`/`rebalancer` viram
 * `tax`/`risk`. A ordem e o corte em 3 são os do chat; `executor` e `navigator` nunca saem.
 */
import type { AopAgent, Schedule } from "@carina/shared";
import { MAX_SPECIALISTS } from "../orchestrator/heuristic.js";

/** Termo curto ou ambíguo: casa só como palavra inteira (mesma forma do chat). */
const word = (term: string, suffix = ""): RegExp =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${term}${suffix}([^\\p{L}\\p{N}]|$)`, "u");

type Matcher = string | RegExp;

/** Ordem fixa do chat (insight, risk, predictor, strategist, tax, researcher, assessor_liaison). */
const KEYWORDS: readonly (readonly [AopAgent, readonly Matcher[]])[] = [
  ["insight", ["portfólio", "análise", "anomalia", "relatório", "briefing", "concentr"]],
  ["risk", ["risco", word("var"), "stress", "rebalance", "volatil"]],
  ["predictor", ["fluxo de caixa", "projeção", "cenário", "previs"]],
  ["strategist", ["planejamento", "longo prazo", "patrimonial", word("metas?")]],
  [
    "tax",
    [
      "tribut",
      "imposto",
      "fiscal",
      word("irpf"),
      word("declaração\\s+de\\s+ir"),
      "harvesting",
      word("darf"),
      "come-cotas",
    ],
  ],
  ["researcher", ["notícia", "pesquis", "mercado", "relatórios externos"]],
  [
    "assessor_liaison",
    [word("assessor(?:es|as|a)?"), "gerente do banco", "perguntar ao", "pergunte ao"],
  ],
];

const DAILY = ["todo dia", "diária", "diario", "diariamente", "diário"];
const MONTHLY = ["todo mês", "mensal", "mensalmente", "fechamento do mês"];

/** 0=segunda … 6=domingo; a ordem de verificação é a do Python. */
const WEEKDAYS: readonly (readonly [string, number])[] = [
  ["segunda", 0],
  ["terça", 1],
  ["terca", 1],
  ["quarta", 2],
  ["quinta", 3],
  ["sexta", 4],
  ["sábado", 5],
  ["sabado", 5],
  ["domingo", 6],
];

/** Padrão: semanal, sexta, 9h (o "11h UTC" do Python). */
const DEFAULT_SCHEDULE: Schedule = { frequency: "weekly", weekday: 4, day: 1, hour: 9 };

const matches = (q: string, m: Matcher): boolean =>
  typeof m === "string" ? q.includes(m) : m.test(q);

export function heuristicCompile(text: string): {
  name: string;
  agents: AopAgent[];
  schedule: Schedule;
} {
  const q = text.normalize("NFC").toLowerCase();
  const agents = KEYWORDS.filter(([, kws]) => kws.some((k) => matches(q, k)))
    .map(([a]) => a)
    .slice(0, MAX_SPECIALISTS);

  const schedule: Schedule = { ...DEFAULT_SCHEDULE };
  if (DAILY.some((k) => q.includes(k))) schedule.frequency = "daily";
  else if (MONTHLY.some((k) => q.includes(k))) schedule.frequency = "monthly";
  const day = WEEKDAYS.find(([name]) => q.includes(name));
  if (day) {
    schedule.frequency = "weekly";
    schedule.weekday = day[1];
  }

  const name = (text.trim().split(/\r?\n/)[0] ?? "").slice(0, 60) || "Procedimento";
  return { name, agents, schedule };
}
