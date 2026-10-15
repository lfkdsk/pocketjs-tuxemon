#!/usr/bin/env bun

import { resolve } from "node:path";

import { lockReplayReleaseArtifacts } from "./tux-link-replay-artifacts.ts";

function argument(name: string): string {
  const equals = process.argv.find((value) => value.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]!;
  throw new Error(`lock-tux-link-replay: ${name} is required`);
}

const directory = resolve(argument("--artifact-dir"));
const assetBase = argument("--asset-base");
const artifacts = await lockReplayReleaseArtifacts(directory, assetBase);
console.log(JSON.stringify({ artifacts }, null, 2));
