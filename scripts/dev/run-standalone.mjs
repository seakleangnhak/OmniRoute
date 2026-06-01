#!/usr/bin/env node

import {
  resolveRuntimePorts,
  withRuntimePortEnv,
  spawnWithForwardedSignals,
} from "../build/runtime-env.mjs";
import { bootstrapEnv } from "../build/bootstrap-env.mjs";
import { existsSync } from "node:fs";

const env = bootstrapEnv();
const runtimePorts = resolveRuntimePorts(env);
const serverEntry = existsSync("server-ws.mjs") ? "server-ws.mjs" : "server.js";

spawnWithForwardedSignals("node", [serverEntry], {
  stdio: "inherit",
  env: withRuntimePortEnv(env, runtimePorts),
});
