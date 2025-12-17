export type KbBinding = { kb_id: string; weight: number; priority: number };
export type KbAllocation = { kb_id: string; top_k: number; weight: number; priority: number };

export function allocateTopK(bindings: KbBinding[], totalK: number): KbAllocation[] {
  const k = Math.max(0, Math.floor(totalK || 0));
  if (k <= 0) return [];

  const clean: KbBinding[] = [];
  for (const b of bindings || []) {
    const kbId = (b.kb_id || "").trim();
    if (!kbId) continue;
    const weight = Number.isFinite(b.weight) && b.weight >= 0 ? Number(b.weight) : 0;
    const priority = Number.isFinite(b.priority) ? Math.trunc(b.priority) : 0;
    clean.push({ kb_id: kbId, weight, priority });
  }

  if (clean.length <= 0) return [];
  if (clean.length === 1) {
    const b = clean[0];
    return [{ kb_id: b.kb_id, top_k: k, weight: b.weight, priority: b.priority }];
  }

  const n = clean.length;
  if (k < n) {
    const ranked = [...clean].sort((a, b) => {
      if (b.weight !== a.weight) return b.weight - a.weight;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.kb_id.localeCompare(b.kb_id);
    });
    return ranked.slice(0, k).map((b) => ({ kb_id: b.kb_id, top_k: 1, weight: b.weight, priority: b.priority }));
  }

  const alloc = new Map<string, number>();
  for (const b of clean) alloc.set(b.kb_id, 1);
  const remaining = k - n;

  let weightSum = clean.reduce((acc, b) => acc + b.weight, 0);
  const weights = new Map<string, number>();
  if (weightSum <= 0) {
    weightSum = n;
    for (const b of clean) weights.set(b.kb_id, 1);
  } else {
    for (const b of clean) weights.set(b.kb_id, b.weight);
  }

  const rawExtra = new Map<string, number>();
  for (const b of clean) rawExtra.set(b.kb_id, (remaining * (weights.get(b.kb_id) || 0)) / weightSum);

  let used = 0;
  for (const [kid, v] of rawExtra.entries()) {
    const inc = Math.max(0, Math.floor(v));
    alloc.set(kid, (alloc.get(kid) || 0) + inc);
    used += inc;
  }

  let left = Math.max(0, remaining - used);
  if (left > 0) {
    const remainders = clean
      .map((b) => {
        const raw = rawExtra.get(b.kb_id) || 0;
        const frac = raw - Math.floor(raw);
        return { frac, weight: weights.get(b.kb_id) || 0, priority: b.priority, kb_id: b.kb_id };
      })
      .sort((a, b) => {
        if (b.frac !== a.frac) return b.frac - a.frac;
        if (b.weight !== a.weight) return b.weight - a.weight;
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.kb_id.localeCompare(b.kb_id);
      });

    for (let i = 0; i < left; i++) {
      const kid = remainders[i % remainders.length].kb_id;
      alloc.set(kid, (alloc.get(kid) || 0) + 1);
    }
  }

  const out = [...clean].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.kb_id.localeCompare(b.kb_id);
  });

  return out.map((b) => ({ kb_id: b.kb_id, top_k: alloc.get(b.kb_id) || 0, weight: b.weight, priority: b.priority }));
}

