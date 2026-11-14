import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../core/database/database.module.js";
import { WatchtowerService } from "./watchtower.service.js";

/** WatchtowerService sem rotas nem guards globais (módulos de serviço e WorkerModule). */
@Module({
  imports: [DatabaseModule],
  providers: [WatchtowerService],
  exports: [WatchtowerService],
})
export class WatchtowerCoreModule {}
