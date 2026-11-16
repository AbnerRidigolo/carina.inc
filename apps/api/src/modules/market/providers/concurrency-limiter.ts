/**
 * Fila no processo que deixa no máximo `max` chamadas em andamento ao mesmo tempo; as demais
 * esperam na ordem de chegada. Quem termina (com sucesso ou erro) passa a vez direto ao próximo.
 * Usada pelo `BrapiProvider`: o plano gratuito da brapi aceita uma requisição concorrente.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError("max precisa ser inteiro >= 1");
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.max) {
      this.active++;
    } else {
      // A vaga é transferida por quem sai (`active` não muda na passagem).
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
