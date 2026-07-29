import { Buffer } from "node:buffer";
import http from "node:http";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const port = Number(process.env.TASK020_PROVIDER_PORT ?? 18888);
const delayMs = Math.max(
  0,
  Number(process.env.PAPERTABLE_FAKE_LLM_DELAY_MS ?? 5000),
);
let connections = 0;
let requests = 0;

const sendJson = (res, value) => {
  const body = JSON.stringify(value);
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
};
const toolName = (body) =>
  body.tools
    ?.map((tool) => tool?.function?.name)
    .find((name) => name === "papertable_probe");
const toolCall = {
  id: "task020-probe",
  type: "function",
  function: { name: "papertable_probe", arguments: '{"probe":"ok"}' },
};

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  requests += 1;
  process.stdout.write(
    `request=${requests} socket=${req.socket.remotePort} stream=${Boolean(body.stream)}\n`,
  );
  await sleep(delayMs);

  if (body.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    if (toolName(body)) {
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: { tool_calls: [{ index: 0, ...toolCall }] },
              finish_reason: "tool_calls",
            },
          ],
        })}\n\n`,
      );
    } else {
      res.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: {
                content: "<<<PAPERTABLE_ANSWER>>>TASK-020 本地 5 秒延迟回答。",
              },
              finish_reason: "stop",
            },
          ],
        })}\n\n`,
      );
    }
    res.end("data: [DONE]\n\n");
    return;
  }

  if (toolName(body) && !body.messages?.some((item) => item.role === "tool")) {
    sendJson(res, {
      choices: [
        {
          message: { role: "assistant", content: null, tool_calls: [toolCall] },
          finish_reason: "tool_calls",
        },
      ],
    });
    return;
  }
  sendJson(res, {
    choices: [
      {
        message: {
          role: "assistant",
          content: "<<<PAPERTABLE_ANSWER>>>TASK-020 本地 5 秒延迟回答。",
        },
        finish_reason: "stop",
      },
    ],
  });
});

server.on("connection", () => {
  connections += 1;
  process.stdout.write(`connection=${connections}\n`);
});
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `TASK-020 delayed provider http://127.0.0.1:${port}/v1 delay=${delayMs}ms\n`,
  );
});
