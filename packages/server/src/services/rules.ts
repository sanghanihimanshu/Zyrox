import {
  createBuiltinHelpers,
  type EvalEnv,
  evaluate,
  helperFunctions,
  MISSING,
  parseExpression,
} from '@wishyor/zyrox-core';
import { bucket } from '../crypto';
import type { ReleaseRule, Variant } from '../db/schema';

export interface TargetingContext {
  user: { id: string };
  client: { platform: string; app: string; manifest: string; protocol: number };
  attrs: Record<string, string>;
  locale: string;
}

const helpers = createBuiltinHelpers(() => 'en');
const callable = helperFunctions(helpers);

/** Evaluates a rule condition. Invalid expressions never match. */
export function matches(when: string | undefined, ctx: TargetingContext): boolean {
  if (!when?.trim()) return true;
  try {
    const roots: Record<string, unknown> = { ...ctx };
    const env: EvalEnv = {
      lookup: (name) => (name in roots ? roots[name] : name in helpers ? helpers[name] : MISSING),
      isCallable: (fn) => typeof fn === 'function' && callable.has(fn),
    };
    return Boolean(evaluate(parseExpression(when), env));
  } catch {
    return false;
  }
}

export function pickVariant(
  variants: readonly Variant[],
  userId: string,
  experimentKey: string,
): Variant | undefined {
  const total = variants.reduce((sum, v) => sum + Math.max(0, v.weight), 0);
  if (total <= 0) return undefined;
  let point = (bucket(experimentKey, userId) / 10000) * total;
  for (const v of variants) {
    point -= Math.max(0, v.weight);
    if (point < 0) return v;
  }
  return variants[variants.length - 1];
}

export interface ExperimentInfo {
  key: string;
  status: string;
  variants: Variant[];
}

export interface Resolution {
  versionId: string;
  experiment?: { key: string; variant: string };
  ruleId?: string;
}

/** First matching rule wins (honoring its rollout); otherwise the default version. */
export function resolveRelease(
  release: { defaultVersionId: string; rules: ReleaseRule[] },
  ctx: TargetingContext,
  experiments: ReadonlyMap<string, ExperimentInfo>,
): Resolution {
  for (const rule of release.rules) {
    if (!matches(rule.when, ctx)) continue;
    const rollout = rule.rollout ?? 100;
    if (rollout < 100 && bucket(rule.id, ctx.user.id) >= rollout * 100) continue;
    if (rule.experimentId) {
      const experiment = experiments.get(rule.experimentId);
      if (experiment?.status !== 'running') continue;
      const variant = pickVariant(experiment.variants, ctx.user.id, experiment.key);
      if (!variant) continue;
      return {
        versionId: variant.versionId,
        experiment: { key: experiment.key, variant: variant.key },
        ruleId: rule.id,
      };
    }
    if (rule.versionId) return { versionId: rule.versionId, ruleId: rule.id };
  }
  return { versionId: release.defaultVersionId };
}
