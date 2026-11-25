import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as Migrator from "effect/sql/Migrator";
import type * as SqlError from "effect/sql/SqlError";

import * as ServerConfig from "../config.ts";
import {
  ExpertSnapshotService,
  layer as expertSnapshotLayer,
} from "./expert/ExpertSnapshotService.ts";
import { ExternalMcpClient, layer as externalMcpLayer } from "./mcp/ExternalMcpClient.ts";
import { McpConnectionService, layer as mcpConnectionLayer } from "./mcp/McpConnectionService.ts";
import { LinxResourceStore, layer as resourcesLayer } from "./persistence/LinxResourceStore.ts";
import { SecretStore, layer as secretStoreLayer } from "./secret/SecretStore.ts";
import { LinxSqlClient, layer as linxSqliteLayer } from "./persistence/LinxSqlite.ts";
import { runLinxMigrations } from "./persistence/Migrations.ts";
import { SkillPackageService, layer as skillPackageLayer } from "./skill/SkillPackageService.ts";
import {
  layer as threadBindingLayer,
  ThreadBindingRepository,
} from "./thread/ThreadBindingRepository.ts";

/** Linx-owned storage and read services shared by the RPC and MCP layers. */
export const layerWithSecrets = (
  secretLayer: Layer.Layer<SecretStore>,
): Layer.Layer<
  | ExpertSnapshotService
  | ThreadBindingRepository
  | SkillPackageService
  | McpConnectionService
  | ExternalMcpClient
  | SecretStore
  | LinxResourceStore
  | LinxSqlClient,
  Migrator.MigrationError | SqlError.SqlError,
  ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
> =>
  Layer.unwrap(
    Effect.map(ServerConfig.ServerConfig, (config) => {
      const sqlite = linxSqliteLayer(config.linxDbPath);
      const migrated = Layer.effectDiscard(runLinxMigrations).pipe(Layer.provideMerge(sqlite));
      const resources = resourcesLayer(config.linxResourceDir);
      const skills = skillPackageLayer.pipe(Layer.provide(resources));
      return Layer.mergeAll(
        expertSnapshotLayer,
        threadBindingLayer,
        skills,
        mcpConnectionLayer.pipe(
          Layer.provideMerge(externalMcpLayer),
          Layer.provideMerge(secretLayer),
        ),
        resources,
      ).pipe(Layer.provideMerge(migrated));
    }),
  );

export const layer = layerWithSecrets(secretStoreLayer);
