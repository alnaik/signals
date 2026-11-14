import { type Ctx, registry } from "./slots.ts";

/** The Threads screen's right-hand column: each feature's block (the sources' status). */
export function Rail({ ctx }: { ctx: Ctx }) {
  return (
    <aside className="rail">
      {registry.map((f) => (
        <span key={f.name} style={{ display: "contents" }}>
          {f.rail?.(ctx)}
        </span>
      ))}
    </aside>
  );
}

/** Whether any feature puts something in the column; without one, the list takes the width. */
export const hasRail = () => registry.some((f) => f.rail);
