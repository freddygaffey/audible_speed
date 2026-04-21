import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { context as esbuildContext } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm } from "node:fs/promises";
import { spawn } from "node:child_process";

globalThis.require = createRequire(import.meta.url);

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(artifactDir, "dist");
const entryOut = path.resolve(distDir, "index.mjs");

let serverProcess = null;

function startServer() {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
  serverProcess = spawn("node", ["--enable-source-maps", entryOut], {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development" },
  });
  serverProcess.on("exit", (code, signal) => {
    if (signal !== "SIGTERM" && code !== 0) {
      console.error(`[dev] server exited with code ${code}`);
    }
  });
}

process.on("SIGINT", () => {
  serverProcess?.kill();
  process.exit(0);
});

await rm(distDir, { recursive: true, force: true });

const ctx = await esbuildContext({
  entryPoints: [path.resolve(artifactDir, "src/index.ts")],
  platform: "node",
  bundle: true,
  format: "esm",
  outdir: distDir,
  outExtension: { ".js": ".mjs" },
  logLevel: "info",
  external: [
    "*.node", "sharp", "better-sqlite3", "sqlite3", "canvas", "bcrypt",
    "argon2", "fsevents", "re2", "farmhash", "xxhash-addon", "bufferutil",
    "utf-8-validate", "ssh2", "cpu-features", "dtrace-provider", "isolated-vm",
    "lightningcss", "pg-native", "oracledb", "mongodb-client-encryption",
    "nodemailer", "handlebars", "knex", "typeorm", "protobufjs",
    "onnxruntime-node", "@tensorflow/*", "@prisma/client", "@mikro-orm/*",
    "@grpc/*", "@swc/*", "@aws-sdk/*", "@azure/*", "@opentelemetry/*",
    "@google-cloud/*", "@google/*", "googleapis", "firebase-admin",
    "@parcel/watcher", "@sentry/profiling-node", "@tree-sitter/*", "aws-sdk",
    "classic-level", "dd-trace", "ffi-napi", "grpc", "hiredis", "kerberos",
    "leveldown", "miniflare", "mysql2", "newrelic", "odbc", "piscina", "realm",
    "ref-napi", "rocksdb", "sass-embedded", "sequelize", "serialport", "snappy",
    "tinypool", "usb", "workerd", "wrangler", "zeromq", "zeromq-prebuilt",
    "playwright", "puppeteer", "puppeteer-core", "electron",
  ],
  sourcemap: "linked",
  plugins: [
    esbuildPluginPino({ transports: ["pino-pretty"] }),
    {
      name: "restart-server",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length === 0) {
            startServer();
          }
        });
      },
    },
  ],
  banner: {
    js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';

globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
    `,
  },
});

await ctx.watch();
console.log("[dev] watching src/ for changes…");
