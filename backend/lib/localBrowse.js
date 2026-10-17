// Backs the "Add workspace" window: a local directory browser and the signed-in
// GitHub account's repositories. These used to be Next.js server routes; living
// here lets Mission Control ship as a static build that `relay serve` hosts.
// Both are host-only — a room member must never browse the host's disk.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function listDrives() {
  const drives = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    try {
      if (fs.existsSync(root)) drives.push({ name: root, path: root, isDir: true });
    } catch {
      /* drive not ready */
    }
  }
  return drives;
}

async function listDir(dir) {
  if (!dir) {
    const entries = process.platform === "win32" ? listDrives() : [{ name: "/", path: "/", isDir: true }];
    return { status: 200, body: { path: null, parent: null, entries } };
  }
  const resolved = path.resolve(dir);
  try {
    const dirents = await fs.promises.readdir(resolved, { withFileTypes: true });
    const entries = dirents
      .map((d) => ({ name: d.name, path: path.join(resolved, d.name), isDir: d.isDirectory() }))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    const parent = path.dirname(resolved);
    return { status: 200, body: { path: resolved, parent: parent === resolved ? null : parent, entries } };
  } catch (err) {
    return { status: 400, body: { error: err.message } };
  }
}

function runGh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("gh timed out"));
    }, 25_000);
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("gh_not_installed"));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `gh exited ${code}`));
    });
  });
}

function classify(message) {
  if (message === "gh_not_installed") return "gh_not_installed";
  if (/not logged|authentication|gh auth login|HTTP 401/i.test(message)) return "gh_not_authenticated";
  return message;
}

const CACHE_MS = 60_000;
let cache = null;

async function listGithubRepos({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.body;
  try {
    const raw = await runGh([
      "api",
      "user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
      "--paginate",
    ]);
    // --paginate concatenates JSON arrays; normalise "][" joins into one array.
    const list = JSON.parse(raw.replace(/\]\s*\[/g, ","));
    const repos = list.map((r) => ({
      id: `gh_${r.id}`,
      name: r.name,
      fullName: r.full_name,
      owner: r.owner?.login ?? null,
      ownerAvatarUrl: r.owner?.avatar_url ?? null,
      description: r.description,
      private: Boolean(r.private),
      fork: Boolean(r.fork),
      language: r.language,
      defaultBranch: r.default_branch,
      cloneUrl: r.clone_url,
      sshUrl: r.ssh_url,
      htmlUrl: r.html_url,
      updatedAt: r.pushed_at || r.updated_at,
      stars: r.stargazers_count || 0,
    }));
    const body = { repos, error: null };
    cache = { at: Date.now(), body };
    return body;
  } catch (err) {
    // Never 500 here — the window renders a helpful empty state off `error`.
    return { repos: [], error: classify(err.message) };
  }
}

module.exports = { listDir, listGithubRepos };
