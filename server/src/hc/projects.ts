import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_PROJECTS = 256;
const MAX_DOCUMENT = 128 * 1024;
const MAX_STATE = 1024 * 1024;

export interface NativeProject {
  id: string;
  roomId: string;
  /** Stable native reference, not a second World project registry. */
  reference: { slug: string; document: string };
  name: string;
  color: string | null;
  folder: string | null;
  match: string | null;
  machine: string | null;
  goal: string;
  body: string;
  folded: boolean;
}
export interface ProjectCatalog {
  projects: NativeProject[];
  /** Native .state.json keys are app space IDs, not terminal addresses. */
  of: Record<string, string>;
  issues: string[];
}
export interface ProjectReadOptions {
  appHome: string;
  /** Read-only seams use paths relative to appHome/projects. Must honor maxBytes. */
  read?: (relativePath: string, maxBytes: number) => Promise<string | null>;
  list?: () => Promise<string[]>;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function json(text: string | null): Record<string, unknown> {
  try {
    return object(JSON.parse(text ?? "{}"));
  } catch {
    return {};
  }
}
function unquote(value: string): string {
  if (/^".*"$/.test(value)) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      /* Native parser also accepts malformed quoted scalars as text. */
    }
    return value.slice(1, -1);
  }
  return /^'.*'$/.test(value) ? value.slice(1, -1).replace(/''/g, "'") : value;
}

/** Deliberately the native flat scalar grammar, NOT a YAML evaluator. */
export function parseProjectDocument(text: string): {
  metadata: Record<string, string>;
  body: string;
} {
  const head = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const metadata: Record<string, string> = Object.create(null);
  if (!head) return { metadata, body: text };
  for (const line of head[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
    if (
      pair &&
      ["name", "color", "folder", "match", "machine"].includes(pair[1]!)
    ) {
      metadata[pair[1]!] = unquote(pair[2]!.trim());
    }
  }
  return { metadata, body: text.slice(head[0].length) };
}

/** Never creates directories, follows project symlinks, or reads arbitrary frontmatter paths. */
export async function readProjectCatalog(
  options: ProjectReadOptions,
): Promise<ProjectCatalog> {
  const root = resolve(options.appHome, "projects");
  const read =
    options.read ??
    (async (relativePath, maxBytes) => {
      const path = join(root, relativePath);
      // Parent directories must remain inside the configured projects root too.
      const canonicalRoot = await realpath(root);
      const canonical = await realpath(path);
      if (!canonical.startsWith(canonicalRoot + sep) || canonical !== path) {
        throw new Error("unsafe-project-path");
      }
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (!(await file.stat()).isFile()) throw new Error("not-project-file");
        const bytes = Buffer.alloc(maxBytes + 1);
        let size = 0;
        while (size < bytes.length) {
          const chunk = await file.read(bytes, size, bytes.length - size, null);
          if (!chunk.bytesRead) break;
          size += chunk.bytesRead;
        }
        if (size > maxBytes) throw new Error("project-read-limit");
        return bytes.subarray(0, size).toString("utf8");
      } finally {
        await file.close();
      }
    });
  const issues: string[] = [];
  const boundedRead = async (path: string, limit: number) => {
    try {
      const text = await read(path, limit);
      if (text !== null && Buffer.byteLength(text) > limit)
        throw new Error("read-limit");
      return text;
    } catch {
      issues.push(`unreadable:${path}`);
      return null;
    }
  };
  let names: string[];
  try {
    names = await (
      options.list ??
      (async () =>
        (await readdir(root, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name))
    )();
  } catch {
    return { projects: [], of: {}, issues: ["unavailable:projects"] };
  }
  const ids = [
    ...new Set(names.filter((id) => id.length <= 100 && SLUG.test(id))),
  ].sort();
  if (ids.length > MAX_PROJECTS) issues.push("limit:projects");
  const state = json(await boundedRead(".state.json", MAX_STATE));
  const order = Array.isArray(state.order)
    ? state.order.filter((id): id is string => typeof id === "string")
    : [];
  const folded = new Set(Array.isArray(state.folded) ? state.folded : []);
  const of: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(object(state.of))) {
    if (
      validId(key) &&
      typeof value === "string" &&
      (value === "" || SLUG.test(value))
    )
      of[key] = value;
  }
  const projects: NativeProject[] = [];
  for (const id of ids.slice(0, MAX_PROJECTS)) {
    const text = await boundedRead(`${id}/PROJECT.md`, MAX_DOCUMENT);
    if (text === null) continue;
    const { metadata: m, body } = parseProjectDocument(text);
    const goal =
      /(^|\n)## Goal[ \t]*\r?\n([\s\S]*?)(?=\n## |$)/.exec(body)?.[2]?.trim() ??
      "";
    projects.push({
      id,
      roomId: `project:${id}`,
      reference: { slug: id, document: `projects/${id}/PROJECT.md` },
      name: m.name || id,
      color: m.color || null,
      folder: m.folder || null,
      match: m.match || null,
      machine: m.machine || null,
      goal,
      body,
      folded: folded.has(id),
    });
  }
  const rank = (id: string) =>
    order.includes(id) ? order.indexOf(id) : Infinity;
  projects.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  return { projects, of, issues };
}

function validId(id: string): boolean {
  return id.length > 0 && id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(id);
}
export interface ProjectEntityRef {
  machine?: string | null;
  id: string;
}
/** Local and remote native IDs cannot collide; never use these display keys as hc addresses. */
export function projectEntityKey(ref: ProjectEntityRef): string {
  if (!validId(ref.id) || (ref.machine != null && !validId(ref.machine)))
    throw new Error("invalid-native-id");
  return ref.machine == null
    ? encodeURIComponent(ref.id)
    : `${encodeURIComponent(ref.machine)}/${encodeURIComponent(ref.id)}`;
}
export interface ProjectTerminal {
  address: string;
  machine?: string | null;
  parent?: string | null;
  cwd?: string;
  foreground?: { cwd?: string } | null;
  labels?: Record<string, string>;
}
export interface ProjectSpace extends ProjectEntityRef {
  name?: string;
  folder?: string | null;
  /** Native app panes order, not hc ls order. */
  terminals: ProjectEntityRef[];
  /** Raw .state.json key when a normalizer qualified the space ID. */
  stateId?: string;
  /** Optional native ordered()/grouped() export or qualified checkout relation. */
  checkout?: ProjectEntityRef;
}
export interface ProjectRoom {
  id: string;
  project: NativeProject | null;
  name: string;
  spaces: ProjectSpace[];
  terminalIds: string[];
}
export interface ProjectProjection {
  rooms: ProjectRoom[];
  terminals: Array<{
    id: string;
    parentId: string | null;
    roomId: string | null;
    terminal: ProjectTerminal;
  }>;
  assignments: Array<{
    spaceId: string;
    roomId: string;
    source: "explicit" | "label" | "folder" | "checkout" | "fallback";
  }>;
  issues: string[];
}

/** Exact native rule grammar: boundary-aware folder, ~ home, * within one component. */
export function projectFolderRule(pattern: string): RegExp | null {
  const p = pattern.trim().replace(/\/+$/, "");
  if (!p || p.length > 4096) return null;
  const body = p
    .replace(/^~/, "\u0000")
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*")
    .replace("\u0000", "(?:/home/[^/]+|/Users/[^/]+|/root)");
  return new RegExp(`${/^[/~]/.test(p) ? "^" : "(?:^|/)"}${body}(?:/|$)`);
}

/** Read-only projection. Labels cannot override explicit assignments/opt-outs or disagreeing peers.
 * Native sidebar worktree inheritance requires checkout (or a native export); cwd/labels alone
 * cannot recover git-common-dir. No git commands, core mutations or project writes occur here.
 */
export function projectRooms(input: {
  catalog: ProjectCatalog;
  spaces: ProjectSpace[];
  terminals: ProjectTerminal[];
  /** Default project context folder rules need the configured absolute appHome. */
  appHome: string;
}): ProjectProjection {
  const { catalog } = input;
  const projects = new Map(catalog.projects.map((p) => [p.id, p]));
  const issues = [...catalog.issues];
  const terminals = new Map<string, ProjectTerminal>();
  for (const terminal of input.terminals) {
    const id = projectEntityKey({
      machine: terminal.machine,
      id: terminal.address,
    });
    if (terminals.has(id)) {
      issues.push(`duplicate-terminal:${id}`);
      continue;
    }
    terminals.set(id, terminal);
  }
  const spaces = new Map<string, ProjectSpace>();
  for (const space of input.spaces) {
    const id = projectEntityKey(space);
    if (spaces.has(id)) {
      issues.push(`duplicate-space:${id}`);
      continue;
    }
    spaces.set(id, space);
  }
  const stateCounts = new Map<string, number>();
  for (const s of spaces.values()) {
    const key = s.stateId ?? s.id;
    stateCounts.set(key, (stateCounts.get(key) ?? 0) + 1);
  }
  type Assignment = {
    project: string | null;
    source: ProjectProjection["assignments"][number]["source"];
  };
  const assigned = new Map<string, Assignment>();
  const resolving = new Set<string>();
  const assign = (id: string): Assignment => {
    const cached = assigned.get(id);
    if (cached) return cached;
    const s = spaces.get(id)!;
    const stateKey = s.stateId ?? s.id;
    const explicit = Object.hasOwn(catalog.of, stateKey);
    let result: Assignment;
    if (explicit && stateCounts.get(stateKey) !== 1) {
      // Ambiguous unqualified state must never assign either machine by accident.
      issues.push(`ambiguous-state:${id}`);
      result = { project: null, source: "fallback" };
    } else if (explicit) {
      const slug = catalog.of[stateKey]!;
      result = {
        project: projects.has(slug) ? slug : null,
        source: "explicit",
      };
    } else {
      const peers = s.terminals
        .map((ref) => terminals.get(projectEntityKey(ref)))
        .filter((t) => t !== undefined);
      const labels = new Set(
        peers
          .map((t) => t.labels?.project)
          .filter((label) => label !== undefined),
      );
      const label = [...labels][0];
      if (labels.size === 1 && label && projects.has(label)) {
        result = { project: label, source: "label" };
      } else {
        if (labels.size > 1 || (label && !projects.has(label)))
          issues.push(`inconsistent-label:${id}`);
        const cwd =
          peers.map((t) => t.foreground?.cwd || t.cwd).find(Boolean) ||
          s.folder;
        const project = catalog.projects.find(
          (p) =>
            cwd &&
            (p.match ?? p.folder ?? join(input.appHome, "projects", p.id))
              .split(",")
              .some((pattern) => projectFolderRule(pattern)?.test(cwd)),
        );
        result = {
          project: project?.id ?? null,
          source: project ? "folder" : "fallback",
        };
      }
    }
    // Sidebar grouped() inherits checkout placement, but an explicit opt-out is never overridden.
    if (!explicit && s.checkout) {
      const parent = projectEntityKey(s.checkout);
      if (spaces.has(parent) && parent !== id && !resolving.has(parent)) {
        resolving.add(id);
        result = { project: assign(parent).project, source: "checkout" };
        resolving.delete(id);
      } else issues.push(`unresolved-checkout:${id}`);
    }
    assigned.set(id, result);
    return result;
  };
  const rooms: ProjectRoom[] = catalog.projects.map((project) => ({
    id: project.roomId,
    name: project.name,
    project,
    spaces: [],
    terminalIds: [],
  }));
  const byRoom = new Map(rooms.map((room) => [room.id, room]));
  const owners = new Map<string, string>();
  const assignments: ProjectProjection["assignments"] = [];
  for (const [id, space] of spaces) {
    const placement = assign(id);
    const roomId = placement.project
      ? `project:${placement.project}`
      : `space:${id}`;
    let room = byRoom.get(roomId);
    if (!room) {
      room = {
        id: roomId,
        project: null,
        name: space.name || space.id,
        spaces: [],
        terminalIds: [],
      };
      rooms.push(room);
      byRoom.set(roomId, room);
    }
    room.spaces.push(space);
    assignments.push({ spaceId: id, roomId, source: placement.source });
    for (const ref of space.terminals) {
      const terminalId = projectEntityKey(ref);
      if (!terminals.has(terminalId)) continue;
      if (owners.has(terminalId)) {
        issues.push(`duplicate-placement:${terminalId}`);
        continue;
      }
      owners.set(terminalId, roomId);
    }
  }
  // Background children absent from app ls inherit their exact-machine parent's room.
  const owner = (id: string, seen = new Set<string>()): string | null => {
    if (owners.has(id)) return owners.get(id)!;
    if (seen.has(id)) return null;
    seen.add(id);
    const t = terminals.get(id);
    if (!t?.parent) return null;
    const roomId = owner(
      projectEntityKey({ machine: t.machine, id: t.parent }),
      seen,
    );
    if (roomId) owners.set(id, roomId);
    return roomId;
  };
  const projected = [...terminals].map(([id, terminal]) => {
    const roomId = owner(id);
    if (roomId) byRoom.get(roomId)!.terminalIds.push(id);
    return {
      id,
      parentId: terminal.parent
        ? projectEntityKey({ machine: terminal.machine, id: terminal.parent })
        : null,
      roomId,
      terminal,
    };
  });
  return { rooms, terminals: projected, assignments, issues };
}
