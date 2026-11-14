import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { LlmModule } from "../llm/llm.module.js";
import { KnowledgeRepository } from "./knowledge.repository.js";
import { KnowledgeService } from "./knowledge.service.js";

/**
 * Conhecimento (pgvector + full-text + grafo). Módulo de serviço, sem rotas HTTP: consumido pelos
 * agentes e pelo worker de Sync. Por isso não importa TenancyModule/LimitsModule (guards globais
 * só importam a quem expõe rotas). Embeddings vêm do ModelFactory (LlmModule).
 */
@Module({
  imports: [DatabaseModule, LlmModule],
  providers: [KnowledgeRepository, KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
