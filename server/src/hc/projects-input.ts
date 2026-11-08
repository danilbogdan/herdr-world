import type { ProjectEntityRef, ProjectSpace } from "./projects";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

/** Decode herdr-app ls ({spaces:[{id,folder,machine,tabs:[{terminals:[{terminal}]}]}]}).
 * sub_agents are not panes; projectRooms discovers them through core parent records instead.
 * Only the exact machine/ prefix declared by the space is removed. The raw space ID
 * is kept as stateId because .state.json uses the app's IDs.
 */
export function projectSpacesFromAppList(value: unknown): ProjectSpace[] {
  return array(record(value).spaces).flatMap((item) => {
    const s = record(item),
      id = text(s.id);
    if (!id || (s.machine != null && !text(s.machine))) return [];
    const machine = text(s.machine) ?? null;
    const localId = (value: string) =>
      machine && value.startsWith(`${machine}/`)
        ? value.slice(machine.length + 1)
        : value;
    const terminals: ProjectEntityRef[] = [];
    for (const tab of array(s.tabs)) {
      for (const pane of array(record(tab).terminals)) {
        const terminal = text(record(pane).terminal);
        if (terminal && text(localId(terminal)))
          terminals.push({ id: localId(terminal), machine });
      }
    }
    return [
      {
        id: localId(id),
        stateId: id,
        machine,
        name: text(s.name),
        folder: typeof s.folder === "string" ? s.folder : null,
        terminals,
      },
    ];
  });
}

/** Native core document: doc.get({name:'herdr-app', on?}) => {value:{spaces},version}.
 * The schema intentionally treats value as opaque. Only known space/tab/node fields are read.
 * Merge one result per explicitly selected machine, never infer a machine from a terminal ID.
 * Sidebar git worktree nesting is runtime mod state, NOT part of this core document.
 */
export function projectSpacesFromCoreDocument(
  reply: unknown,
  machine: string | null = null,
): ProjectSpace[] {
  if (machine !== null && !text(machine)) return [];
  const result = record(reply);
  if (
    typeof result.version !== "number" ||
    !Number.isSafeInteger(result.version) ||
    result.version < 0
  )
    return [];
  return array(record(result.value).spaces).flatMap((item) => {
    const s = record(item),
      id = text(s.id);
    if (!id) return [];
    const terminals: ProjectEntityRef[] = [];
    let budget = 8192;
    const walk = (value: unknown, depth: number) => {
      if (--budget < 0 || depth > 64) return;
      const node = record(value);
      if (node.type === "block") {
        const terminal = text(record(node.content).terminal);
        if (terminal) terminals.push({ id: terminal, machine });
      }
      // Node order is native pane order. Do not crawl arbitrary opaque metadata.
      for (const child of array(node.children)) walk(child, depth + 1);
    };
    for (const tab of array(s.tabs)) walk(record(tab).root, 0);
    return [
      {
        id,
        machine,
        name: text(s.name),
        folder: typeof s.folder === "string" ? s.folder : null,
        terminals,
      },
    ];
  });
}
