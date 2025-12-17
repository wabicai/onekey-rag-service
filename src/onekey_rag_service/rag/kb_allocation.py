from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class KbBinding:
    kb_id: str
    weight: float
    priority: int


@dataclass(frozen=True)
class KbAllocation:
    kb_id: str
    top_k: int
    weight: float
    priority: int


def allocate_top_k(bindings: list[KbBinding], *, total_k: int) -> list[KbAllocation]:
    """
    将一次检索的 topK 按“权重/优先级”分配到多个 KB。

    规则：
    - enabled 逻辑在调用侧过滤（这里只处理 bindings）
    - priority 越小越优先（同权重/同余数时优先获得 +1）
    - total_k < KB 数量时：只给前 total_k 个 KB 分配 1（按 weight DESC, priority ASC）
    - total_k >= KB 数量时：先给每个 KB 1，再按 weight 分配剩余
    """

    k = max(0, int(total_k))
    if k <= 0:
        return []

    clean: list[KbBinding] = []
    for b in bindings:
        kid = (b.kb_id or "").strip()
        if not kid:
            continue
        w = float(b.weight or 0.0)
        if not math.isfinite(w) or w < 0:
            w = 0.0
        clean.append(KbBinding(kb_id=kid, weight=w, priority=int(b.priority or 0)))

    if not clean:
        return []

    if len(clean) == 1:
        b = clean[0]
        return [KbAllocation(kb_id=b.kb_id, top_k=k, weight=b.weight, priority=b.priority)]

    # total_k < n：只给“更重要”的 KB 分配 1
    n = len(clean)
    if k < n:
        ranked = sorted(clean, key=lambda x: (-x.weight, x.priority, x.kb_id))
        chosen = ranked[:k]
        return [KbAllocation(kb_id=b.kb_id, top_k=1, weight=b.weight, priority=b.priority) for b in chosen]

    # 先给每个 KB 1，再分配剩余
    base_alloc = {b.kb_id: 1 for b in clean}
    remaining = k - n

    w_sum = sum(b.weight for b in clean)
    if w_sum <= 0:
        # 权重都为 0：按优先级均分
        w_sum = float(n)
        weights = {b.kb_id: 1.0 for b in clean}
    else:
        weights = {b.kb_id: b.weight for b in clean}

    raw_extra = {b.kb_id: (remaining * weights[b.kb_id] / w_sum) for b in clean}
    extra_base = {kid: int(math.floor(v)) for kid, v in raw_extra.items()}
    for kid, inc in extra_base.items():
        base_alloc[kid] += max(0, inc)

    used = sum(extra_base.values())
    left = max(0, remaining - used)
    if left > 0:
        remainders = []
        for b in clean:
            kid = b.kb_id
            frac = float(raw_extra[kid] - math.floor(raw_extra[kid]))
            # frac 越大越优先；同 frac 时 weight 越大越优先；再按 priority 越小越优先
            remainders.append((frac, float(weights[kid]), -int(b.priority), kid))
        remainders.sort(reverse=True)
        for i in range(left):
            kid = remainders[i % len(remainders)][3]
            base_alloc[kid] += 1

    # 输出保持按 priority 排序，便于解释与调试
    out: list[KbAllocation] = []
    by_id = {b.kb_id: b for b in clean}
    for b in sorted(clean, key=lambda x: (x.priority, x.kb_id)):
        out.append(KbAllocation(kb_id=b.kb_id, top_k=int(base_alloc.get(b.kb_id, 0)), weight=b.weight, priority=b.priority))
    return out
