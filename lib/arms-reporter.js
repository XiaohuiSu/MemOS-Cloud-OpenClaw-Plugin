import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ARMS_ENDPOINT = "https://proj-xtrace-e218d9316b328f196a3c640cc7ca84-cn-hangzhou.cn-hangzhou.log.aliyuncs.com/rum/web/v2?workspace=default-cms-1026429231103299-cn-hangzhou&service_id=a3u72ukxmr@bed68dd882dd823439015"
const ARMS_PID = "a3u72ukxmr@c42a249fb14f4d9";
const ARMS_ENV = "prod";
const ARMS_UID_ENV_KEY = "MEMOS_ARMS_UID";
const OPENCLAW_HOME_DIR = join(homedir(), ".openclaw");
const OPENCLAW_ENV_FILE = join(homedir(), ".openclaw", ".env");

let armsUidCache = "";

function readEnvValueFromFile(key) {
  try {
    const lines = readFileSync(OPENCLAW_ENV_FILE, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      const idx = line.indexOf("=");
      if (idx <= 0) continue;
      const currentKey = line.slice(0, idx).trim();
      if (currentKey !== key) continue;
      const rawValue = line.slice(idx + 1).trim();
      if (
        (rawValue.startsWith("\"") && rawValue.endsWith("\"")) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))
      ) {
        return rawValue.slice(1, -1).trim();
      }
      return rawValue;
    }
    return "";
  } catch {
    return "";
  }
}

function writeEnvValueToFile(key, value) {
  const nextLine = `${key}=${value}`;
  try {
    mkdirSync(OPENCLAW_HOME_DIR, { recursive: true });
    const content = readFileSync(OPENCLAW_ENV_FILE, "utf-8");
    const lines = content.split(/\r?\n/).filter((line, index, arr) => !(index === arr.length - 1 && line === ""));
    let replaced = false;
    const output = lines.map((line) => {
      const idx = line.indexOf("=");
      if (idx <= 0) return line;
      const currentKey = line.slice(0, idx).trim();
      if (currentKey !== key) return line;
      replaced = true;
      return nextLine;
    });
    if (!replaced) output.push(nextLine);
    writeFileSync(OPENCLAW_ENV_FILE, `${output.join("\n")}\n`, { mode: 0o600 });
  } catch {
    try {
      mkdirSync(OPENCLAW_HOME_DIR, { recursive: true });
      writeFileSync(OPENCLAW_ENV_FILE, `${nextLine}\n`, { mode: 0o600 });
    } catch {}
  }
}

function createEventId() {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return `00-${traceId}-${spanId}`;
}

function loadArmsUid() {
  if (armsUidCache) return armsUidCache;
  const fromEnv = process.env[ARMS_UID_ENV_KEY]?.trim();
  if (fromEnv) {
    armsUidCache = fromEnv;
    writeEnvValueToFile(ARMS_UID_ENV_KEY, armsUidCache);
    return armsUidCache;
  }
  const fromEnvFile = readEnvValueFromFile(ARMS_UID_ENV_KEY);
  if (fromEnvFile) {
    armsUidCache = fromEnvFile;
    process.env[ARMS_UID_ENV_KEY] = armsUidCache;
    return armsUidCache;
  }
  armsUidCache = `uid_${randomUUID()}`;
  process.env[ARMS_UID_ENV_KEY] = armsUidCache;
  writeEnvValueToFile(ARMS_UID_ENV_KEY, armsUidCache);
  return armsUidCache;
}

function buildPayload(ctx, eventName, payload) {
  return {
    app: {
      id: ARMS_PID,
      env: ARMS_ENV,
      type: "node",
    },
    user: { id: loadArmsUid() },
    session: { id: ctx.sessionId },
    net: {},
    view: { id: "plugin", name: "memos-cloud-openclaw" },
    events: [
      {
        event_id: createEventId(),
        event_type: 'custom',
        type: "memos_plugin",
        group: "memos_cloud",
        name: eventName,
        timestamp: +new Date(),
        properties: { ...payload }
      }
    ]
  };
}

export async function reportRumEvent(eventName, payload, cfg, ctx, log) {
  if (!cfg.rumEnabled) return;
  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    Number.isFinite(cfg.rumTimeoutMs) ? Math.max(1000, cfg.rumTimeoutMs) : 3000,
  );
  const body = buildPayload(ctx, eventName, payload)

  try {
    const res = await fetch(ARMS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    log.warn(`上报结果：${res.ok}, ${res.status}, ${res.statusText}`)
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (err) {
    log.warn?.(`[memos-cloud] RUM report failed: ${String(err)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}
