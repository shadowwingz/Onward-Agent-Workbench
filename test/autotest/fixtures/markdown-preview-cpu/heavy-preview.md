<!-- SPDX-FileCopyrightText: 2026 OPPO -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Markdown Preview CPU Fixture

This fixture is intentionally dense enough to exercise the Markdown preview path without depending on a user-local Notes directory.

![CPU preview fixture](cpu-dot.svg)

```mermaid
flowchart LR
  A["Markdown source"] --> B["Worker render"]
  B --> C["Safe HTML"]
  C --> D["Preview DOM"]
  D --> E["Idle CPU gate"]
```

$$
\sum_{t=1}^{T} \alpha_t \cdot \nabla L_t = \Delta W
$$

| Step | Operation | Expected UI state | CPU expectation |
|---|---|---|---|
| 1 | Open Markdown | Preview visible | bounded render spike |
| 2 | Wait for settle | `previewRestorePhase=idle` | renderer helper returns to idle |
| 3 | Keep app idle | No loading animations | sustained CPU remains low |

## Repeated Study Notes

### Section 01

The preview should render paragraphs, tables, math, code, images, and Mermaid without leaving a running loading indicator behind.

```ts
export function schedule(step: number): number {
  return Math.exp(-step / 1000) * Math.cos(step / 10)
}
```

$$
QK^\top / \sqrt{d_k} = \operatorname{attention}(Q, K)
$$

| Metric | Value | Comment |
|---|---:|---|
| tokens | 4096 | context length |
| layers | 32 | transformer blocks |
| heads | 32 | attention heads |

### Section 02

The content is repetitive by design so layout height is non-trivial and scroll code has real work to inspect.

```python
def warmup(step: int, total: int) -> float:
    return min(1.0, step / max(total, 1))
```

$$
\theta_i = 10000^{-2i/d}
$$

| Schedule | Warmup | Decay | Notes |
|---|---:|---:|---|
| cosine | 500 | 9500 | smooth tail |
| linear | 1000 | 9000 | predictable |
| constant | 0 | 0 | baseline |

### Section 03

Markdown preview restore must not depend on the editor pane being visible. Preview-only mode should settle just like split mode.

```json
{
  "mode": "preview-only",
  "phase": "idle",
  "animations": 0
}
```

$$
\operatorname{RoPE}(x, p) =
\begin{bmatrix}
\cos p\theta & -\sin p\theta \\
\sin p\theta & \cos p\theta
\end{bmatrix}x
$$

| Case | Editor | Preview | Result |
|---|---|---|---|
| split | visible | visible | stable |
| preview | hidden | visible | stable |
| editor | visible | hidden | no preview work |

### Section 04

The CPU gate is expected to fail if hidden Git Diff or Git History skeleton animations keep running while the Project Editor is active.

```bash
printf '%s\n' "renderer helper must go idle"
```

$$
L = -\sum_i y_i \log \hat{y}_i
$$

| Hidden panel | Animation | Allowed |
|---|---|---|
| Git Diff | skeleton pulse | no |
| Git Diff | loading dots | no |
| Git History | spinner | no |

### Section 05

This final section gives the preview enough height for scroll recovery checks.

```tsx
function PreviewGate() {
  return <section data-state="idle">Ready</section>
}
```

$$
\mu_t = \beta \mu_{t-1} + (1-\beta)g_t
$$

| Trial | Samples | Pass condition |
|---|---:|---|
| idle | 20 | avg <= budget |
| scroll | 10 | may spike |
| recovery | 15 | avg <= budget |
