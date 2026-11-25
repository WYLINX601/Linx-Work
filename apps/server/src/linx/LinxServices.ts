import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Migrator from "effect/sql/Migrator";
import type * as SqlError from "effect/sql/SqlError";

import * as ServerConfig from "../config.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import { layer as t3ThreadLauncherLayer } from "./adapters/t3/ThreadLauncher.ts";
import {
  ExpertSnapshotService,
  layer as expertSnapshotLayer,
} from "./expert/ExpertSnapshotService.ts";
import { layer as linxSqliteLayer } from "./persistence/LinxSqlite.ts";
import { runLinxMigrations } from "./persistence/Migrations.ts";
import { layer as launchLayer, LinxLaunchService } from "./thread/LinxLaunchService.ts";
import {
  layer as threadBindingLayer,
  ThreadBindingRepository,
} from "./thread/ThreadBindingRepository.ts";

/** Linx storage plus the launch service used by RPC and the MCP toolkit. */
export const layer: Layer.Layer<
  ExpertSnapshotService | ThreadBindingRepository | LinxLaunchService,
  Migrator.MigrationError | SqlError.SqlError,
  | ServerConfig.ServerConfig
  | DocumentText.DocumentText
  | FileSystem.FileSystem
  | ThreadLaunch.ThreadLaunchService
> = Layer.unwrap(
  Effect.map(ServerConfig.ServerConfig, (config) => {
    const sqlite = linxSqliteLayer(config.linxDbPath);
    const migrated = Layer.effectDiscard(runLinxMigrations).pipe(Layer.provideMerge(sqlite));
    const storage = Layer.mergeAll(expertSnapshotLayer, threadBindingLayer).pipe(
      Layer.provideMerge(migrated),
    );
    const launch = launchLayer.pipe(Layer.provide(storage), Layer.provide(t3ThreadLauncherLayer));
    return Layer.mergeAll(expertSnapshotLayer, threadBindingLayer, launch).pipe(
      Layer.provideMerge(migrated),
    );
  }),
);
