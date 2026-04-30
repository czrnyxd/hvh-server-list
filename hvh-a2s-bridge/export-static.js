const dgram = require("node:dgram");
const fs = require("node:fs");
const path = require("node:path");

const QUERY_TIMEOUT_MS = Number(process.env.QUERY_TIMEOUT_MS || 3000);
const QUERY_CONCURRENCY = Number(process.env.QUERY_CONCURRENCY || 25);
const SERVER_FILE = path.join(__dirname, "servers.txt");
const PUBLIC_DIR = path.join(__dirname, "..", "public");

function loadServerList() {
  if (process.env.SERVERS) {
    return process.env.SERVERS.split(",");
  }

  if (fs.existsSync(SERVER_FILE)) {
    return fs.readFileSync(SERVER_FILE, "utf8").split(/\r?\n/);
  }

  return ["51.77.47.242:27015"];
}

function cleanServerList(values) {
  const seen = new Set();
  const servers = [];

  for (const value of values) {
    const address = value.replace(/#.*$/, "").trim();
    if (!address || seen.has(address)) continue;
    seen.add(address);
    servers.push(address);
  }

  return servers.length > 0 ? servers : ["51.77.47.242:27015"];
}

function parseAddress(address) {
  const [host, rawPort] = address.split(":");
  const port = Number(rawPort || 27015);

  return {
    host,
    port,
    address: `${host}:${port}`,
  };
}

function sourceQueryPacket(challenge) {
  const query = Buffer.from("Source Engine Query\0", "ascii");
  const header = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]);
  return challenge ? Buffer.concat([header, query, challenge]) : Buffer.concat([header, query]);
}

function readCString(buffer, offsetRef) {
  const start = offsetRef.offset;

  while (offsetRef.offset < buffer.length && buffer[offsetRef.offset] !== 0) {
    offsetRef.offset += 1;
  }

  const value = buffer.toString("utf8", start, offsetRef.offset);
  offsetRef.offset += 1;
  return value;
}

function parseA2SInfo(buffer, address, pingMs) {
  const ref = { offset: 5 };

  const protocol = buffer.readUInt8(ref.offset);
  ref.offset += 1;

  const name = readCString(buffer, ref);
  const map = readCString(buffer, ref);
  const folder = readCString(buffer, ref);
  const game = readCString(buffer, ref);
  const appid = buffer.readUInt16LE(ref.offset);
  ref.offset += 2;

  const players = buffer.readUInt8(ref.offset);
  ref.offset += 1;
  const max_players = buffer.readUInt8(ref.offset);
  ref.offset += 1;
  const bots = buffer.readUInt8(ref.offset);
  ref.offset += 1;

  const server_type = String.fromCharCode(buffer.readUInt8(ref.offset));
  ref.offset += 1;
  const environment = String.fromCharCode(buffer.readUInt8(ref.offset));
  ref.offset += 1;
  const visibility = buffer.readUInt8(ref.offset);
  ref.offset += 1;
  const vac = buffer.readUInt8(ref.offset);
  ref.offset += 1;
  const version = readCString(buffer, ref);

  let keywords = "";
  if (ref.offset < buffer.length) {
    const edf = buffer.readUInt8(ref.offset);
    ref.offset += 1;

    if ((edf & 0x80) && ref.offset + 2 <= buffer.length) ref.offset += 2;
    if ((edf & 0x10) && ref.offset + 8 <= buffer.length) ref.offset += 8;
    if ((edf & 0x40) && ref.offset < buffer.length) {
      ref.offset += 2;
      readCString(buffer, ref);
    }
    if ((edf & 0x20) && ref.offset < buffer.length) {
      keywords = readCString(buffer, ref);
    }
  }

  return {
    address,
    online: true,
    ping_ms: pingMs,
    protocol,
    name,
    map,
    folder,
    game,
    appid,
    players,
    max_players,
    bots,
    server_type,
    environment,
    visibility,
    vac,
    version,
    keywords,
    updated_at: new Date().toISOString(),
  };
}

function queryServer(address) {
  const target = parseAddress(address);
  const startedAt = Date.now();

  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    let challengeAttempts = 0;
    let finished = false;

    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        address: target.address,
        online: false,
        error: "timeout",
        updated_at: new Date().toISOString(),
      });
    }, QUERY_TIMEOUT_MS);

    const send = (packet) => {
      socket.send(packet, 0, packet.length, target.port, target.host, (error) => {
        if (!error) return;
        finish({
          address: target.address,
          online: false,
          error: error.message,
          updated_at: new Date().toISOString(),
        });
      });
    };

    socket.on("message", (buffer) => {
      if (buffer.length < 5) return;

      if (buffer.readInt32LE(0) === -2) {
        finish({
          address: target.address,
          online: false,
          error: "split-packet response is not supported yet",
          updated_at: new Date().toISOString(),
        });
        return;
      }

      if (buffer.readInt32LE(0) !== -1) return;

      const type = buffer.readUInt8(4);

      if (type === 0x41 && buffer.length >= 9) {
        challengeAttempts += 1;
        if (challengeAttempts > 3) {
          finish({
            address: target.address,
            online: false,
            error: "too many challenge responses",
            updated_at: new Date().toISOString(),
          });
          return;
        }

        send(sourceQueryPacket(buffer.subarray(5, 9)));
        return;
      }

      if (type === 0x49) {
        try {
          finish(parseA2SInfo(buffer, target.address, Date.now() - startedAt));
        } catch (error) {
          finish({
            address: target.address,
            online: false,
            error: `parse failed: ${error.message}`,
            updated_at: new Date().toISOString(),
          });
        }
        return;
      }

      finish({
        address: target.address,
        online: false,
        error: `unexpected response type 0x${type.toString(16)}`,
        updated_at: new Date().toISOString(),
      });
    });

    socket.on("error", (error) => {
      finish({
        address: target.address,
        online: false,
        error: error.message,
        updated_at: new Date().toISOString(),
      });
    });

    send(sourceQueryPacket());
  });
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function run() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

function writeIndex(servers) {
  const generatedAt = new Date().toISOString();
  const rows = servers
    .map((server) => {
      const name = escapeHtml(server.name || server.error || "offline");
      const address = escapeHtml(server.address);
      const map = escapeHtml(server.map || "-");
      const players = server.online ? `${server.players}/${server.max_players}` : "-";
      const ping = server.online ? `${server.ping_ms}ms` : "-";

      return `<tr><td>${address}</td><td>${name}</td><td>${map}</td><td>${players}</td><td>${ping}</td></tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HvH Server Browser Data</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; background: #101214; color: #f3f3f3; }
    table { border-collapse: collapse; width: 100%; max-width: 1200px; }
    th, td { border-bottom: 1px solid #2c3035; padding: 10px; text-align: left; }
    th { color: #aeb7c2; font-weight: 600; }
    a { color: #7ab7ff; }
  </style>
</head>
<body>
  <h1>HvH Server Browser Data</h1>
  <p>Generated at ${generatedAt}. JSON endpoint: <a href="./servers.json">servers.json</a></p>
  <table>
    <thead><tr><th>Address</th><th>Name</th><th>Map</th><th>Players</th><th>Ping</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function main() {
  const servers = cleanServerList(loadServerList());
  const results = await mapLimit(servers, QUERY_CONCURRENCY, queryServer);

  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(path.join(PUBLIC_DIR, "servers.json"), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(PUBLIC_DIR, "index.html"), writeIndex(results));
  fs.writeFileSync(path.join(PUBLIC_DIR, ".nojekyll"), "");

  const online = results.filter((server) => server.online).length;
  console.log(`Wrote ${results.length} servers (${online} online) to ${PUBLIC_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
