#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `ARMADRA_CORE=ts` 的身份链条，端到端跑一遍真进程。
 *
 * 做的事，按顺序：
 *
 *   1. 起一个 core（`node out/core/main.js`），它会应用统一库迁移 0015——如果
 *      库是 Rust 建的，应用前会留下一份 `canvas.db.before-ts-core-<ts>`；
 *   2. 从数据目录下那个 0600 的私有通道取票（壳走的就是这条路）；
 *   3. 拿票换会话（`/rpc/armadra.v1.IdentityService/Pair`，前端今天发的那一个）；
 *   4. 同一张票再换一次——必须被拒（一次性）；
 *   5. 用会话读 `Current`、列设备、撤销设备；
 *   6. 撤销之后旧会话必须 401。
 *
 * 先跑 `pnpm --filter @armadra/desktop build`（或 `electron-vite build`）。
 * `--data-dir` 指向一个已有的数据目录可以顺便验单向门；默认用临时目录。
 */

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const MEDIA = "application/x-protobuf";

const options = parse(process.argv.slice(2));
const entry = options.entry ?? join(repo, "apps/desktop/out/core/main.js");
if (!existsSync(entry)) {
  fail(`找不到 core 产物 ${entry}；先跑 pnpm --filter @armadra/desktop build`);
}

const temporary = options.dataDir === undefined;
const dataDir =
  options.dataDir ?? mkdtempSync(join(tmpdir(), "armadra-core-smoke-"));
const origin = "http://127.0.0.1:1420";

let core;
let failures = 0;

try {
  const started = await startCore(entry, dataDir);
  core = started.process;
  say(`core 已就绪：${started.base}（instance ${started.instanceId}）`);

  const backups = readdirSync(dataDir).filter((name) =>
    name.includes("before-ts-core"),
  );
  say(
    backups.length > 0
      ? `单向门备份：${backups.join(", ")}（sha256 ${sha256(join(dataDir, backups[0]))}）`
      : "单向门备份：无（这个库是新建的，没有可回滚的内容）",
  );
  const absorbed = readdirSync(dataDir).filter((name) =>
    name.includes("host.db.absorbed-"),
  );
  if (absorbed.length > 0) say(`旧 host.db 已吸收：${absorbed.join(", ")}`);

  const protocol = await import(
    pathToFileUrl(join(repo, "packages/protocol/dist/index.js"))
  ).catch(() => import("@armadra/protocol"));
  const {
    AuthenticatedSessionSchema,
    CurrentSessionRequestSchema,
    ErrorResponseSchema,
    HelloRequestSchema,
    HelloResponseSchema,
    ListDevicesRequestSchema,
    ListDevicesResponseSchema,
    PairDeviceRequestSchema,
    PROTOCOL_MAJOR,
    PROTOCOL_MINOR,
    RevokeDeviceRequestSchema,
    RevokeDeviceResponseSchema,
    create,
    fromBinary,
    toBinary,
  } = protocol;

  const rpc = async (method, schema, message, headers = {}) => {
    const response = await post(
      `${started.base}/rpc/armadra.v1.${method}`,
      Buffer.from(toBinary(schema, message)),
      { "content-type": MEDIA, accept: MEDIA, origin, ...headers },
    );
    return response;
  };

  // Hello：页面拿 hostId / instanceId / 能力位。
  const hello = await rpc(
    "HostService/Hello",
    HelloRequestSchema,
    create(HelloRequestSchema, {
      clientId: "core-identity-smoke",
      protocol: { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR },
    }),
  );
  const helloBody = fromBinary(HelloResponseSchema, hello.body);
  check("Hello 报 200", hello.status === 200);
  check(
    "Hello 报原生会话能力",
    helloBody.capabilities.includes("identity.native-session.v1"),
  );
  check(
    "Hello 报浏览器会话能力",
    helloBody.capabilities.includes("identity.browser-session.v1"),
  );
  check(
    "Hello 的 hostId 是 32 位十六进制",
    /^[0-9a-f]{32}$/.test(helloBody.hostId),
  );

  // 取票：壳走的那条私有通道。
  const first = await ticket(dataDir, origin);
  check(
    "私有通道签出一张票",
    /^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/.test(first.ticket),
  );
  check("票绑定这次的 hostId", first.hostId === helloBody.hostId);
  check(
    "票绑定这次的 instance",
    first.hostInstanceId === helloBody.hostInstanceId,
  );

  // 换会话。
  const paired = await rpc(
    "IdentityService/Pair",
    PairDeviceRequestSchema,
    create(PairDeviceRequestSchema, {
      ticket: first.ticket,
      expectedHostId: first.hostId,
      expectedInstanceId: first.hostInstanceId,
    }),
  );
  check("票换会话成功", paired.status === 200);
  const session = fromBinary(AuthenticatedSessionSchema, paired.body);
  check("会话带回原生凭据", Boolean(session.native?.accessToken));
  check("回环 HTTP 不发 Cookie", paired.headers["set-cookie"] === undefined);
  const access = session.native.accessToken;
  const csrf = session.csrfToken;

  // 一次性：同一张票第二次必须被拒。
  const replay = await rpc(
    "IdentityService/Pair",
    PairDeviceRequestSchema,
    create(PairDeviceRequestSchema, {
      ticket: first.ticket,
      expectedHostId: first.hostId,
      expectedInstanceId: first.hostInstanceId,
    }),
  );
  check("同一张票第二次被拒", replay.status === 401);
  check(
    "拒绝的理由是 UNAUTHENTICATED",
    fromBinary(ErrorResponseSchema, replay.body).code === "UNAUTHENTICATED",
  );

  // 一张没签过的票（形状对、内容假）也必须被拒。
  const forged = await rpc(
    "IdentityService/Pair",
    PairDeviceRequestSchema,
    create(PairDeviceRequestSchema, {
      ticket: `${randomUUID().replace(/-/g, "")}.${"A".repeat(43)}`,
      expectedHostId: first.hostId,
      expectedInstanceId: first.hostInstanceId,
    }),
  );
  check("伪造的票被拒", forged.status === 401);

  // 用会话。
  const current = await rpc(
    "IdentityService/Current",
    CurrentSessionRequestSchema,
    create(CurrentSessionRequestSchema),
    { authorization: `Bearer ${access}` },
  );
  check("会话读得出自己", current.status === 200);

  const devices = await rpc(
    "IdentityService/ListDevices",
    ListDevicesRequestSchema,
    create(ListDevicesRequestSchema, { limit: 50 }),
    { authorization: `Bearer ${access}` },
  );
  const page = fromBinary(ListDevicesResponseSchema, devices.body);
  check("设备列表里有这一台", page.devices.length >= 1);

  // 撤销。
  const revoked = await rpc(
    "IdentityService/RevokeDevice",
    RevokeDeviceRequestSchema,
    create(RevokeDeviceRequestSchema, {
      deviceId: session.device.deviceId,
      expectedRevision: session.device.revision,
    }),
    { authorization: `Bearer ${access}`, "x-armadra-csrf": csrf },
  );
  check("撤销成功", revoked.status === 200);
  check(
    "撤销有回执",
    fromBinary(RevokeDeviceResponseSchema, revoked.body).revoked === true,
  );

  const after = await rpc(
    "IdentityService/Current",
    CurrentSessionRequestSchema,
    create(CurrentSessionRequestSchema),
    { authorization: `Bearer ${access}` },
  );
  check("撤销后旧会话 401", after.status === 401);

  // 新面：同一套语义，JSON 的外衣。
  const second = await ticket(dataDir, origin);
  const apiPaired = await post(
    `${started.base}/api/identity/pair`,
    Buffer.from(JSON.stringify({ ticket: second.ticket }), "utf8"),
    { "content-type": "application/json", origin },
  );
  check("新面也能配对", apiPaired.status === 200);
  const apiSession = JSON.parse(apiPaired.body.toString("utf8"));
  const apiCurrent = await get(`${started.base}/api/identity/session`, {
    origin,
    authorization: `Bearer ${apiSession.native.accessToken}`,
  });
  check("新面读得出会话", apiCurrent.status === 200);
} catch (error) {
  failures += 1;
  say(`✗ ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (core !== undefined) {
    core.kill("SIGTERM");
    await new Promise((done) => core.once("exit", done));
  }
  if (temporary) rmSync(dataDir, { recursive: true, force: true });
}

if (failures > 0) {
  say(`${failures} 项未通过`);
  process.exit(1);
}
say("身份链条全部通过");

/* --------------------------------- 工具 ---------------------------------- */

function parse(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--data-dir") result.dataDir = argv[(index += 1)];
    else if (flag === "--entry") result.entry = argv[(index += 1)];
    else if (flag === "--help") {
      say(
        "用法：node tools/core-identity-smoke.mjs [--data-dir DIR] [--entry out/core/main.js]",
      );
      process.exit(0);
    } else fail(`认不出的参数：${flag}`);
  }
  return result;
}

function say(line) {
  process.stdout.write(`${line}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function check(label, condition) {
  if (condition) {
    say(`✓ ${label}`);
    return;
  }
  failures += 1;
  say(`✗ ${label}`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pathToFileUrl(path) {
  return `file://${path}`;
}

async function startCore(entry, dataDir) {
  const child = spawn(
    process.execPath,
    [entry, "--listen", "tcp:127.0.0.1:0", "--data-dir", dataDir],
    {
      env: { ...process.env, ARMADRA_CORE: "ts" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let text = "";
  const instanceId = await new Promise((done, stop) => {
    const timer = setTimeout(
      () => stop(new Error("core 没有在 20 秒内宣告自己")),
      20_000,
    );
    child.stdout.on("data", (chunk) => {
      text += chunk.toString("utf8");
      const found = /instance ([0-9a-f-]{32,40})/.exec(text);
      if (found) {
        clearTimeout(timer);
        done(found[1]);
      }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("exit", (code) => {
      clearTimeout(timer);
      stop(new Error(`core 退出了（${code}）：${text}`));
    });
  });
  // 端点文件是唯一知道内核分给哪个端口的东西。
  const endpoints = join(dataDir, "endpoints.json");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(endpoints)) {
      const document = JSON.parse(readFileSync(endpoints, "utf8"));
      const http = document?.runtime?.http ?? document?.services?.runtime?.http;
      if (typeof http === "string" && http !== "") {
        return { process: child, base: http, instanceId };
      }
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error("core 没有公告它的地址");
}

function ticket(dataDir, origin) {
  return socketPost(
    join(dataDir, "core-control.sock"),
    "/control/identity/ticket",
    { origin, deviceName: "本机桌面" },
  ).then((answer) => {
    if (answer.status !== 200) {
      throw new Error(`私有通道拒绝签票：${answer.status} ${answer.body}`);
    }
    return JSON.parse(answer.body);
  });
}

function socketPost(socketPath, path, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return new Promise((done, stop) => {
    const call = request(
      {
        socketPath,
        path,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    call.on("error", stop);
    call.end(body);
  });
}

async function post(url, body, headers) {
  const response = await fetch(url, {
    method: "POST",
    headers: { ...headers, "content-length": String(body.byteLength) },
    body: new Uint8Array(body),
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: Buffer.from(await response.arrayBuffer()),
  };
}

async function get(url, headers) {
  const response = await fetch(url, { headers });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: Buffer.from(await response.arrayBuffer()),
  };
}
