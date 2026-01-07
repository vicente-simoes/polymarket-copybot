
import type { ExecutionAdapter } from '../ports/ExecutionAdapter';

let globalExecutor: ExecutionAdapter | null = null;

export function setExecutor(executor: ExecutionAdapter) {
    globalExecutor = executor;
}

export function getExecutor(): ExecutionAdapter | null {
    return globalExecutor;
}
