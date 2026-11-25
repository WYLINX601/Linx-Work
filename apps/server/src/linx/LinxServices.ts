import * as Layer from "effect/Layer";

import { layer as t3ThreadLauncherLayer } from "./adapters/t3/ThreadLauncher.ts";
import { layer as expertDefinitionLayer } from "./expert/ExpertDefinitionService.ts";
import { layer as storageLayer } from "./LinxMcpServices.ts";
import { layer as launchLayer } from "./thread/LinxLaunchService.ts";

const definitions = expertDefinitionLayer;
const launch = launchLayer.pipe(Layer.provide(t3ThreadLauncherLayer), Layer.provide(definitions));

export const layer = Layer.mergeAll(definitions, launch).pipe(Layer.provideMerge(storageLayer));
