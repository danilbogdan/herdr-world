import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProjectDocument,
  projectEntityKey,
  projectFolderRule,
  projectRooms,
  readProjectCatalog,
  type ProjectCatalog,
  type ProjectSpace,
  type ProjectTerminal,
} from "./projects";

import {
  projectSpacesFromAppList,
  projectSpacesFromCoreDocument,
} from "./projects-input";

const appHome = "/synthetic/app";
async function catalog(
  state: object = {},
  documents: Record<string, string> = {
    alpha:
      "---\nname: Alpha\nfolder: /code/alpha\n---\n# A\n\n## Goal\n\nShip it.\n\n## Scope\nSmall.\n",
    beta: "---\nname: Beta\nmatch: beta\nmachine: other\n---\n# B\n",
    empty: "# Empty project\n",
  },
): Promise<ProjectCatalog> {
  return readProjectCatalog({
    appHome,
    list: async () => Object.keys(documents),
    read: async (path) => {
      if (path === ".state.json") return JSON.stringify(state);
      return documents[path.split("/")[0]!] ?? null;
    },
  });
}
function space(
  id: string,
  terminal: string,
  extra: Partial<ProjectSpace> = {},
): ProjectSpace {
  return {
    id,
    terminals: [{ id: terminal, machine: extra.machine }],
    ...extra,
  };
}
const terminal = (
  address: string,
  extra: Partial<ProjectTerminal> = {},
): ProjectTerminal => ({ address, ...extra });
function project(
  c: ProjectCatalog,
  spaces: ProjectSpace[],
  terminals: ProjectTerminal[],
) {
  return projectRooms({ catalog: c, spaces, terminals, appHome });
}

describe("native project catalog", () => {
  test("keeps native order, body, goal, curated metadata, stable references and empty projects", async () => {
    const c = await catalog({ order: ["empty", "beta"], folded: ["beta"] });
    expect(c.projects.map((p) => p.id)).toEqual(["empty", "beta", "alpha"]);
    const a = c.projects[2]!;
    expect(a.goal).toBe("Ship it.");
    expect(a.body).toStartWith("# A");
    expect(a.reference).toEqual({
      slug: "alpha",
      document: "projects/alpha/PROJECT.md",
    });
    expect(c.projects[1]!.folded).toBe(true);
    expect(c.projects[1]!.machine).toBe("other");
    expect(project(c, [], []).rooms.map((r) => [r.id, r.terminalIds])).toEqual([
      ["project:empty", []],
      ["project:beta", []],
      ["project:alpha", []],
    ]);
  });
  test("uses only native flat strings; no YAML tags, nested structures or unknown metadata", () => {
    expect(
      parseProjectDocument(
        "---\r\nname: 'It''s here'\r\ncolor: \"ansi4\"\r\nsecret: nope\r\nfolder:\r\n  nested: no\r\n---\r\nBody",
      ),
    ).toEqual({
      metadata: { name: "It's here", color: "ansi4", folder: "" },
      body: "Body",
    });
    expect(
      parseProjectDocument("---\nname: !!js/function evil\n---\n").metadata
        .name,
    ).toBe("!!js/function evil");
  });
  test("restricts slug read paths, caps injected reads, does not read MEMORY.md", async () => {
    const calls: string[] = [];
    const c = await readProjectCatalog({
      appHome,
      list: async () => ["../escape", ".archive", "valid", "too-big"],
      read: async (path) => {
        calls.push(path);
        return path.startsWith("too-big/") ? "x".repeat(129 * 1024) : "# Safe";
      },
    });
    expect(c.projects.map((p) => p.id)).toEqual(["valid"]);
    expect(calls).toEqual([
      ".state.json",
      "too-big/PROJECT.md",
      "valid/PROJECT.md",
    ]);
    expect(c.issues).toContain("unreadable:too-big/PROJECT.md");
  });
  test("filesystem default refuses symlinked project files and never creates a missing root", async () => {
    const root = await mkdtemp(join(tmpdir(), "world-projects-"));
    try {
      expect(
        (await readProjectCatalog({ appHome: join(root, "absent") })).projects,
      ).toEqual([]);
      await mkdir(join(root, "projects", "safe"), { recursive: true });
      await mkdir(join(root, "projects", "unsafe"));
      await writeFile(join(root, "outside.md"), "# Outside");
      await writeFile(join(root, "projects", "safe", "PROJECT.md"), "# Safe");
      await symlink(
        join(root, "outside.md"),
        join(root, "projects", "unsafe", "PROJECT.md"),
      );
      const c = await readProjectCatalog({ appHome: root });
      expect(c.projects.map((p) => p.id)).toEqual(["safe"]);
      expect(c.issues).toContain("unreadable:unsafe/PROJECT.md");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("native observation inputs", () => {
  test("app ls preserves spaces/pane order and machine context without duplicating subagents", () => {
    const spaces = projectSpacesFromAppList({
      spaces: [
        {
          id: "s",
          machine: "remote",
          folder: "/code/alpha",
          tabs: [
            {
              terminals: [
                { terminal: "t1", sub_agents: ["t2"] },
                { terminal: "t3" },
              ],
            },
          ],
        },
      ],
    });
    expect(spaces[0]!.terminals).toEqual([
      { id: "t1", machine: "remote" },
      { id: "t3", machine: "remote" },
    ]);
    expect(spaces[0]!.machine).toBe("remote");
    const qualified = projectSpacesFromAppList({
      spaces: [
        {
          id: "remote/s",
          machine: "remote",
          tabs: [{ terminals: [{ terminal: "remote/t1" }] }],
        },
      ],
    });
    expect(qualified[0]!.id).toBe("s");
    expect(qualified[0]!.stateId).toBe("remote/s");
    expect(qualified[0]!.terminals).toEqual([{ id: "t1", machine: "remote" }]);
  });
  test("native herdr-app core doc decodes nested block content, retaining pane order and empty spaces", async () => {
    const spaces = projectSpacesFromCoreDocument(
      {
        version: 2,
        value: {
          spaces: [
            {
              id: "s",
              folder: "/old",
              tabs: [
                {
                  root: {
                    type: "row",
                    children: [
                      { type: "block", content: { terminal: "t1" } },
                      {
                        type: "column",
                        children: [
                          { type: "block", content: { terminal: "t2" } },
                        ],
                      },
                    ],
                  },
                },
              ],
            },
            { id: "empty", tabs: [] },
          ],
        },
      },
      "remote",
    );
    expect(spaces[0]!.terminals).toEqual([
      { id: "t1", machine: "remote" },
      { id: "t2", machine: "remote" },
    ]);
    expect(spaces[1]!.terminals).toEqual([]);
    const p = project(await catalog(), spaces, [
      terminal("t1", { machine: "remote", foreground: { cwd: "/code/alpha" } }),
    ]);
    expect(p.assignments.map((a) => a.roomId)).toEqual([
      "project:alpha",
      "space:remote/empty",
    ]);
    expect(projectSpacesFromCoreDocument({ version: 0, value: null })).toEqual(
      [],
    );
    expect(
      projectSpacesFromCoreDocument({
        version: 1,
        value: { spaces: [{ id: "bad\u0000id" }] },
      }),
    ).toEqual([]);
  });
});

describe("read-only native assignment projection", () => {
  test("explicit assignment wins labels/cwd; explicit empty opt-out and deleted project block matches", async () => {
    const c = await catalog({ of: { s1: "beta", s2: "", s3: "vanished" } });
    const p = project(
      c,
      [space("s1", "t1"), space("s2", "t2"), space("s3", "t3")],
      ["t1", "t2", "t3"].map((id) =>
        terminal(id, {
          foreground: { cwd: "/code/alpha" },
          labels: { project: "alpha" },
        }),
      ),
    );
    expect(p.assignments.map((a) => [a.roomId, a.source])).toEqual([
      ["project:beta", "explicit"],
      ["space:s2", "explicit"],
      ["space:s3", "explicit"],
    ]);
  });
  test("consistent existing labels are authoritative; conflicting/vanished labels fall back to native place", async () => {
    const p = project(
      await catalog(),
      [
        space("s1", "t1"),
        { id: "s2", terminals: [{ id: "t2" }, { id: "t3" }] },
        space("s3", "t4"),
      ],
      [
        terminal("t1", { cwd: "/code/alpha", labels: { project: "beta" } }),
        terminal("t2", { cwd: "/code/alpha", labels: { project: "beta" } }),
        terminal("t3", { labels: { project: "alpha" } }),
        terminal("t4", { cwd: "/code/alpha", labels: { project: "vanished" } }),
      ],
    );
    expect(p.assignments.map((a) => [a.roomId, a.source])).toEqual([
      ["project:beta", "label"],
      ["project:alpha", "folder"],
      ["project:alpha", "folder"],
    ]);
    expect(p.issues).toEqual([
      "inconsistent-label:s2",
      "inconsistent-label:s3",
    ]);
  });
  test("live foreground cwd wins initial cwd/space folder in native pane order, project order breaks ties", async () => {
    const c = await catalog({ order: ["beta", "alpha"] });
    c.projects[0]!.match = "alpha";
    const p = project(
      c,
      [
        {
          id: "s",
          folder: "/elsewhere",
          terminals: [{ id: "t2" }, { id: "t1" }],
        },
      ],
      [
        terminal("t1", { foreground: { cwd: "/elsewhere" } }),
        terminal("t2", {
          cwd: "/elsewhere",
          foreground: { cwd: "/code/alpha/sub" },
        }),
      ],
    );
    expect(p.assignments[0]!.roomId).toBe("project:beta");
  });
  test("boundary-aware rules support any depth, tilde homes and single-component globs", () => {
    for (const [pattern, yes, no] of [
      ["alpha", "/code/alpha/sub", "/code/alphabet"],
      ["/code/alpha/", "/code/alpha", "/other/code/alpha"],
      [
        "~/code/a-*",
        "/Users/example/code/a-one/sub",
        "/Users/example/code/b-one",
      ],
      ["/code/*/alpha", "/code/one/alpha", "/code/one/two/alpha"],
      ["/code/a.b", "/code/a.b", "/code/axb"],
    ]) {
      expect(projectFolderRule(pattern!)!.test(yes!)).toBe(true);
      expect(projectFolderRule(pattern!)!.test(no!)).toBe(false);
    }
  });
  test("machine-qualified IDs never collide or retarget children; duplicate placements are omitted", async () => {
    const c = await catalog();
    const p = project(
      c,
      [
        space("s", "t1"),
        space("s", "t1", { machine: "remote" }),
        space("duplicate", "t1"),
      ],
      [
        terminal("t1", { labels: { project: "alpha" } }),
        terminal("t2", { parent: "t1" }),
        terminal("t1", { machine: "remote", labels: { project: "beta" } }),
        terminal("t2", { machine: "remote", parent: "t1" }),
        terminal("t1", { labels: { project: "beta" } }),
      ],
    );
    expect(p.terminals.map((t) => [t.id, t.parentId, t.roomId])).toEqual([
      ["t1", null, "project:alpha"],
      ["t2", "t1", "project:alpha"],
      ["remote/t1", null, "project:beta"],
      ["remote/t2", "remote/t1", "project:beta"],
    ]);
    expect(p.rooms.find((r) => r.id === "project:alpha")!.terminalIds).toEqual([
      "t1",
      "t2",
    ]);
    expect(p.issues).toContain("duplicate-terminal:t1");
    expect(p.issues).toContain("duplicate-placement:t1");
    expect(projectEntityKey({ id: "remote/t1" })).not.toBe(
      projectEntityKey({ id: "t1", machine: "remote" }),
    );
  });
  test("ambiguous raw state across machines fails closed rather than assigning either host", async () => {
    const p = project(
      await catalog({ of: { s: "alpha" } }),
      [space("s", "t1"), space("s", "t1", { machine: "remote" })],
      [terminal("t1"), terminal("t1", { machine: "remote" })],
    );
    expect(p.assignments.map((a) => a.roomId)).toEqual([
      "space:s",
      "space:remote/s",
    ]);
    expect(p.issues).toEqual(["ambiguous-state:s", "ambiguous-state:remote/s"]);
  });
  test("explicit state IDs from native app export can distinguish machine collisions", async () => {
    const p = project(
      await catalog({ of: { localSpace: "alpha", remoteSpace: "beta" } }),
      [
        space("s", "t1", { stateId: "localSpace" }),
        space("s", "t1", { machine: "remote", stateId: "remoteSpace" }),
      ],
      [],
    );
    expect(p.assignments.map((a) => a.roomId)).toEqual([
      "project:alpha",
      "project:beta",
    ]);
  });
  test("checkout seam provides sidebar worktree inheritance, without overriding opt-out", async () => {
    const p = project(
      await catalog({ of: { optedOut: "" } }),
      [
        space("worktree", "t2", { checkout: { id: "checkout" } }),
        space("checkout", "t1"),
        space("optedOut", "t3", { checkout: { id: "checkout" } }),
      ],
      [
        terminal("t1", { cwd: "/code/alpha" }),
        terminal("t2", { cwd: "/worktrees/branch" }),
      ],
    );
    expect(p.assignments.map((a) => [a.roomId, a.source])).toEqual([
      ["project:alpha", "checkout"],
      ["project:alpha", "folder"],
      ["space:optedOut", "explicit"],
    ]);
  });
  test("retains orphan/cyclic parent records without accidentally attaching to another machine", async () => {
    const p = project(
      await catalog(),
      [space("s", "t1")],
      [
        terminal("t1"),
        terminal("t2", { machine: "remote", parent: "t1" }),
        terminal("t3", { parent: "t4" }),
        terminal("t4", { parent: "t3" }),
      ],
    );
    expect(p.terminals.slice(1).map((t) => t.roomId)).toEqual([
      null,
      null,
      null,
    ]);
    expect(p.terminals[1]!.parentId).toBe("remote/t1");
  });
});
