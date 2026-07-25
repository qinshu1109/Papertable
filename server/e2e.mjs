import { spawn } from "node:child_process";

const env = {
  ...process.env,
  PAPERTABLE_FAKE_LLM: "1",
  PAPERTABLE_PORT: "8782",
  PAPERTABLE_API_PORT: "8782",
  PAPERTABLE_WEB_PORT: "5174",
};
const options = { cwd: process.cwd(), env, stdio: "inherit" };
const api = spawn(process.execPath, ["server/index.mjs"], options);
const web = spawn(
  process.execPath,
  ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "5174"],
  options,
);

const close = () => {
  api.kill("SIGTERM");
  web.kill("SIGTERM");
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
api.on("exit", (code) => {
  if (code && code !== 0) process.exitCode = code;
});
web.on("exit", (code) => {
  if (code && code !== 0) process.exitCode = code;
});
