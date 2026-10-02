#!/usr/bin/env node
/**
 * `plumb` CLI 진입점 (기획안 §4.3 · §4.5). 명령 트리는 `program.ts`.
 * 설정 로더는 `../config/`에 있으며, 하위 명령이 구현될 때 `--target`을 넘겨 쓴다.
 */

import { createProgram } from './program.js';

await createProgram().parseAsync(process.argv);
