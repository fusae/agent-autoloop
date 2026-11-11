// Failure modes: wrong accounts publish, an ambiguous timeout causes duplicate posts,
// draft-only success is accepted, platform blank-line tabs hide a real post, or invalid images are uploaded.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { xhsPublication, parseXhsDraft } from "../plugins/xiaohongshu/publisher.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9n8AAAAASUVORK5CYII=";
function request(action = "lookup", text = "明天记得还书。") {
  const content = JSON.stringify({
    title: "记下一件事",
    content: text,
    images: [{ mime: "image/png", base64: png }],
  });
  return {
    action,
    key: "a".repeat(32),
    business: "jizhu",
    channel: "小红书",
    artifacts: [
      { path: "tasks/demo/xiaohongshu.json", content, sha256: createHash("sha256").update(content).digest("hex") },
    ],
  };
}
const config = { endpoint: "http://127.0.0.1:18060", token: "test", accountId: "owner", enabled: true };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "company-xhs-"));
  let posts = 0,
    loggedIn = true,
    accountId = "owner",
    show = false,
    failPost = false;
  const call = async (path: string, body?: any): Promise<any> => {
    if (path === "/api/v1/login/creator-status") return { is_logged_in: true, can_publish: true };
    if (path === "/api/v1/login/status") return { is_logged_in: loggedIn };
    if (path === "/api/v1/user/me")
      return {
        data: {
          userBasicInfo: { userId: accountId },
          feeds: show ? [{ id: "b".repeat(24), xsecToken: "test", noteCard: { displayTitle: "记下一件事" } }] : [],
        },
      };
    if (path === "/api/v1/feeds/detail")
      return {
        data: {
          note: {
            noteId: "b".repeat(24),
            title: "记下一件事",
            desc: "明天记得还书。",
            user: { userId: accountId },
            time: Date.now(),
            imageList: [{}],
          },
        },
      };
    if (path === "/api/v1/publish") {
      posts++;
      assert.equal(body.images.length, 1);
      if (failPost) throw Error("timeout");
      return { status: "发布完成" };
    }
    throw Error(path);
  };
  return {
    directory,
    call,
    posts: () => posts,
    login: (v: boolean) => (loggedIn = v),
    account: (v: string) => (accountId = v),
    show: () => (show = true),
    fail: () => (failPost = true),
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
test("login, pinned account and explicit activation are required before publishing", async () => {
  const f = fixture();
  try {
    f.login(false);
    await assert.rejects(xhsPublication(config, f.directory, request(), f.call), /扫码/);
    f.login(true);
    f.account("someone-else");
    await assert.rejects(xhsPublication(config, f.directory, request(), f.call), /账号/);
    f.account("owner");
    await assert.rejects(
      xhsPublication({ ...config, enabled: false }, f.directory, request("publish"), f.call),
      /启用/,
    );
    assert.equal(f.posts(), 0);
  } finally {
    f.close();
  }
});
test("API success is not proof; replay reconciles platform content without republishing", async () => {
  const f = fixture();
  try {
    assert.equal((await xhsPublication(config, f.directory, request(), f.call)).state, "absent");
    assert.equal((await xhsPublication(config, f.directory, request("publish"), f.call)).state, "unknown");
    assert.equal((await xhsPublication(config, f.directory, request(), f.call)).state, "unknown");
    await xhsPublication(config, f.directory, request("publish"), f.call);
    assert.equal(f.posts(), 1);
    f.show();
    const proof = await xhsPublication(config, f.directory, request(), f.call);
    assert.equal(proof.state, "published");
    assert.equal(proof.remoteId, "b".repeat(24));
    await xhsPublication(config, f.directory, request("publish"), f.call);
    assert.equal(f.posts(), 1);
  } finally {
    f.close();
  }
});
test("timeout persists an attempt before network write and never blindly retries", async () => {
  const f = fixture();
  try {
    f.fail();
    await assert.rejects(xhsPublication(config, f.directory, request("publish"), f.call), /timeout/);
    assert.equal((await xhsPublication(config, f.directory, request(), f.call)).state, "unknown");
    await xhsPublication(config, f.directory, request("publish"), f.call);
    assert.equal(f.posts(), 1);
  } finally {
    f.close();
  }
});
test("readback tolerates blank-line tabs but retains content and publication checks", async () => {
  const f = fixture();
  const content = "明天记得还书。\n\n带上借书卡。";
  try {
    await xhsPublication(config, f.directory, request("publish", content), f.call);
    f.show();
    let changes: Record<string, unknown> = {};
    let duplicate = false;
    const readback = async (path: string, body?: any) => {
      const data = await f.call(path, body);
      if (path === "/api/v1/feeds/detail")
        Object.assign(data.data.note, { desc: " 明天记得还书。 \n\t\n 带上借书卡。\t" }, changes);
      if (path === "/api/v1/user/me" && duplicate) data.data.feeds.push(data.data.feeds[0]);
      return data;
    };
    assert.equal((await xhsPublication(config, f.directory, request("lookup", content), readback)).state, "published");
    for (const mismatch of [
      { desc: "明天记得买书。\n\t\n带上借书卡。" },
      { desc: "明天记得 还书。\n\t\n带上借书卡。" },
      { user: { userId: "other" } },
      { noteId: "c".repeat(24) },
      { title: "另一篇" },
      { imageList: [] },
      { time: Date.now() - 120_000 },
      { time: Date.now() + 120_000 },
    ]) {
      changes = mismatch;
      assert.equal((await xhsPublication(config, f.directory, request("lookup", content), readback)).state, "unknown");
    }
    changes = {};
    duplicate = true;
    assert.equal((await xhsPublication(config, f.directory, request("lookup", content), readback)).state, "unknown");
    assert.equal(f.posts(), 1);
  } finally {
    f.close();
  }
});
test("same title without a durable attempt is ambiguous, never a fresh publish", async () => {
  const f = fixture();
  try {
    f.show();
    assert.equal((await xhsPublication(config, f.directory, request("publish"), f.call)).state, "unknown");
    assert.equal(f.posts(), 0);
  } finally {
    f.close();
  }
});
test("reviewed manifest must include valid image bytes and a matching digest", () => {
  const r = request();
  assert.equal(parseXhsDraft(r).title, "记下一件事");
  r.artifacts[0].content += " ";
  assert.throws(() => parseXhsDraft(r), /审核/);
  const bad = request();
  bad.artifacts[0].content = JSON.stringify({
    title: "test",
    content: "text",
    images: [{ mime: "image/png", base64: "L2V0Yy9wYXNzd2Q=" }],
  });
  bad.artifacts[0].sha256 = createHash("sha256").update(bad.artifacts[0].content).digest("hex");
  assert.throws(() => parseXhsDraft(bad), /图片/);
});

test("mismatched platform text and account changes cannot verify or resend a post", async () => {
  const f = fixture();
  try {
    await xhsPublication(config, f.directory, request("publish"), f.call);
    f.show();
    const mismatch = async (path: string, body?: any) => {
      const data = await f.call(path, body);
      if (path === "/api/v1/feeds/detail") data.data.note.desc = "另外一篇内容";
      return data;
    };
    assert.equal((await xhsPublication(config, f.directory, request(), mismatch)).state, "unknown");
    f.account("other");
    await assert.rejects(xhsPublication(config, f.directory, request("publish"), f.call), /账号/);
    assert.equal(f.posts(), 1);
  } finally {
    f.close();
  }
});

test("parallel calls cannot publish twice", async () => {
  const f = fixture();
  try {
    const results = await Promise.allSettled([
      xhsPublication(config, f.directory, request("publish"), f.call),
      xhsPublication(config, f.directory, request("publish"), f.call),
    ]);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(f.posts(), 1);
  } finally {
    f.close();
  }
});

test("HTTP client authenticates locally, rejects failed envelopes and remote endpoints", async () => {
  const { createServer } = await import("node:http");
  const { xhsApi } = await import("../plugins/xiaohongshu/publisher.ts");
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer test");
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        req.url === "/ok"
          ? { success: true, data: { is_logged_in: true } }
          : { success: false, error: "private upstream details" },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    const call = xhsApi({ endpoint: `http://127.0.0.1:${address.port}`, token: "test" });
    assert.equal((await call("/ok")).is_logged_in, true);
    await assert.rejects(call("/bad"), /接口未完成/);
    assert.throws(() => xhsApi({ endpoint: "https://example.com", token: "secret" }), /本机/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("frozen company delivery runs the real adapter over HTTP and replays without duplicate publication", async () => {
  const { writeFileSync, mkdirSync, readFileSync } = await import("node:fs");
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { freezePublication, executePublication } = await import("../plugins/company/publication.ts");
  const dir = mkdtempSync(join(tmpdir(), "xhs-e2e-"));
  const serverFile = join(dir, "server.mjs"),
    counter = join(dir, "count");
  writeFileSync(
    serverFile,
    `import {createServer} from 'node:http';import{writeFileSync}from'node:fs';let note=null,count=0;
  const server=createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;let data;
  if(req.headers.authorization!=='Bearer test'){res.writeHead(401);res.end('{}');return;}
  if(req.url==='/api/v1/login/status')data={is_logged_in:true,user_id:'owner'};
  else if(req.url==='/api/v1/login/creator-status')data={is_logged_in:true,can_publish:true};
  else if(req.url==='/api/v1/user/me')data={data:{userBasicInfo:{userId:'owner'},feeds:note?[{id:'bbbbbbbbbbbbbbbbbbbbbbbb',xsecToken:'test',noteCard:{displayTitle:note.title}}]:[]}};
  else if(req.url==='/api/v1/publish'){const body=JSON.parse(text);note={noteId:'bbbbbbbbbbbbbbbbbbbbbbbb',title:body.title,desc:body.content,time:Date.now(),user:{userId:'owner'},imageList:body.images.map(()=>({}))};writeFileSync(${JSON.stringify(counter)},String(++count));data={status:'发布完成'};}
  else if(req.url==='/api/v1/feeds/detail')data={data:{note}};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({success:true,data}));
  });server.listen(0,'127.0.0.1',()=>console.log(server.address().port));`,
  );
  const child = spawn(process.execPath, [serverFile], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.once("data", (b) => resolve(Number(String(b).trim())));
    });
    const cfg = join(dir, "connector.json");
    writeFileSync(cfg, JSON.stringify({ ...config, endpoint: `http://127.0.0.1:${port}` }));
    mkdirSync(join(dir, "workspace"));
    const r = request();
    writeFileSync(join(dir, "workspace/xiaohongshu.json"), r.artifacts[0].content);
    const key = freezePublication(dir, "jizhu", "plan", {
      id: "draft",
      assignment: 1,
      reports: [{ artifacts: ["xiaohongshu.json"] }],
    } as any);
    writeFileSync(
      join(dir, "publishing.json"),
      JSON.stringify({
        projects: {
          jizhu: {
            channel: "小红书",
            command: [
              process.execPath,
              fileURLToPath(new URL("../plugins/xiaohongshu/publish-run.ts", import.meta.url)),
              cfg,
            ],
          },
        },
      }),
    );
    const proof = executePublication(dir, key);
    assert.equal(proof.remoteId, "b".repeat(24));
    assert.equal(readFileSync(counter, "utf8"), "1");
    rmSync(join(dir, "publications", key + "-result.json"));
    assert.deepEqual(executePublication(dir, key), proof);
    assert.equal(readFileSync(counter, "utf8"), "1");
  } finally {
    child.kill();
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

// A public profile can stay logged in while the creator center rejects publishing before submission.
test("creator login rejection survives lookup without exposing private upstream details or reposting", async () => {
  const { XhsLoginRequired, xhsApi } = await import("../plugins/xiaohongshu/publisher.ts");
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "PUBLISH_FAILED", details: "创作者中心登录失效，请重新扫码登录" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const f = fixture();
  let writes = 0;
  try {
    const api = xhsApi({ endpoint: `http://127.0.0.1:${(server.address() as any).port}`, token: "test" });
    await assert.rejects(api("/api/v1/publish", {}), XhsLoginRequired);
    const call = async (path: string, body?: unknown) => {
      if (path === "/api/v1/publish") {
        writes++;
        throw new XhsLoginRequired();
      }
      return f.call(path, body);
    };
    await assert.rejects(xhsPublication(config, f.directory, request("publish"), call), /需董事长本人验证/);
    assert.equal((await xhsPublication(config, f.directory, request("lookup"), call)).state, "absent");
    assert.equal((await xhsPublication(config, f.directory, request("publish"), f.call)).state, "unknown");
    assert.equal(writes, 1);
  } finally {
    f.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

// A killed write can leave its per-draft lock, but readback must still recover the original post.
test("a stale write lock does not block readback or a different draft", async () => {
  const f = fixture();
  try {
    await xhsPublication(config, f.directory, request("publish"), f.call);
    mkdirSync(join(f.directory, request().key + ".lock"));
    f.show();
    assert.equal((await xhsPublication(config, f.directory, request(), f.call)).state, "published");
    assert.equal(f.posts(), 1);
  } finally { f.close(); }
});
