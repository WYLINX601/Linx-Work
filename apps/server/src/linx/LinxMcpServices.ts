import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Migrator from "effect/sql/Migrator";
import type * as SqlError from "effect/sql/SqlError";

import * as ServerConfig from "../config.ts";
import {
  ExpertSnapshotService,
  layer as expertSnapshotLayer,
} from "./expert/ExpertSnapshotService.ts";
import { layer as linxSqliteLayer } from "./persistence/LinxSqlite.ts";
import { runLinxMigrations } from "./persistence/Migrations.ts";
import {
  layer as threadBindingLayer,
  ThreadBindingRepository,
} from "./thread/ThreadBindingRepository.ts";

/** Linx-owned storage and read services used by the T3 MCP toolkit. */
export const layer: Layer.Layer<
  ExpertSnapshotService | ThreadBindingRepository,
  Migrator.MigrationError | SqlError.SqlError,
  ServerConfig.ServerConfig
> = Layer.unwrap(
  Effect.map(ServerConfig.ServerConfig, (config) => {
    const sqlite = linxSqliteLayer(config.linxDbPath);
    const migrated = Layer.effectDiscard(runLinxMigrations).pipe(Layer.provideMerge(sqlite));
    return Layer.mergeAll(expertSnapshotLayer, threadBindingLayer).pipe(Layer.provide(migrated));
  }),
);
