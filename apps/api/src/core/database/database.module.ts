import { Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service.js";
import { TenantPrismaService } from "./tenant-prisma.service.js";

/** Depende do ENV do ConfigModule (global). */
@Module({
  providers: [PrismaService, TenantPrismaService],
  exports: [PrismaService, TenantPrismaService],
})
export class DatabaseModule {}
