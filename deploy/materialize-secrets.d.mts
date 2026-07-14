export interface MaterializeProductionSecretsOptions {
  readonly bundle: unknown;
  readonly root: string;
  readonly uid?: number;
  readonly gid?: number;
}

export interface MaterializedProductionSecrets {
  readonly root: string;
  readonly files: number;
}

export function materializeProductionSecrets(
  options: MaterializeProductionSecretsOptions
): Promise<MaterializedProductionSecrets>;
