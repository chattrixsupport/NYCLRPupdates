const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const SESSION_COOKIE = "nyclrp_session";
const STATE_COOKIE = "nyclrp_oauth_state";
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_SECONDS = SESSION_LIFETIME_MS / 1000;
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/script.js", ["script.js", "text/javascript; charset=utf-8"]],
]);

function getOAuthConfig(environment) {
  const { DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, DISCORD_REDIRECT_URI } = environment;
  if (!DISCORD_CLIENT_ID || !DISCORD_CLIENT_SECRET || !DISCORD_REDIRECT_URI) {
    throw new Error("Set DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, and DISCORD_REDIRECT_URI.");
  }

  let redirectUrl;
  try {
    redirectUrl = new URL(DISCORD_REDIRECT_URI);
  } catch {
    throw new Error("DISCORD_REDIRECT_URI must be a valid URL.");
  }

  const isLocalHttp =
    redirectUrl.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(redirectUrl.hostname);
  if (redirectUrl.protocol !== "https:" && !isLocalHttp) {
    throw new Error("DISCORD_REDIRECT_URI must use HTTPS except for local development.");
  }
  if (
    redirectUrl.pathname !== "/auth/discord/callback" ||
    redirectUrl.search ||
    redirectUrl.hash
  ) {
    throw new Error("DISCORD_REDIRECT_URI must end with /auth/discord/callback and have no query or fragment.");
  }

  return {
    clientId: DISCORD_CLIENT_ID,
    clientSecret: DISCORD_CLIENT_SECRET,
    redirectUri: redirectUrl.toString(),
    secureCookies: redirectUrl.protocol === "https:",
  };
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split(/=(.*)/s, 2))
      .filter(([name, value]) => name && value !== undefined),
  );
}

function cookie(name, value, maxAge, secure) {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function clearCookie(name, secure) {
  return cookie(name, "", 0, secure);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function redirect(response, location, cookies = []) {
  response.writeHead(302, {
    "Cache-Control": "no-store",
    Location: location,
    "Set-Cookie": cookies,
  });
  response.end();
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left || "");
  const rightBuffer = Buffer.from(right || "");
  return (
    leftBuffer.length === rightBuffer.length &&
    leftBuffer.length > 0 &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function loadEnvironmentFile() {
  const filePath = path.join(__dirname, ".env");
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) {
      continue;
    }

    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    process.env[match[1]] = value;
  }
}

function createServer({ environment = process.env, fetchImpl = fetch, logger = console } = {}) {
  const sessions = new Map();
  const publicDirectory = __dirname;

  return http.createServer(async (request, response) => {
    response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' https://cdn.discordapp.com; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://discord.com");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    response.setHeader("X-Content-Type-Options", "nosniff");

    let requestUrl;
    try {
      requestUrl = new URL(request.url, "http://localhost");
    } catch (error) {
      logger.error("Invalid request URL:", error);
      response.writeHead(400).end("Bad request");
      return;
    }

    const cookies = parseCookies(request.headers.cookie);

    if (request.method === "GET" && requestUrl.pathname === "/auth/discord") {
      let config;
      try {
        config = getOAuthConfig(environment);
      } catch (error) {
        logger.error("Discord OAuth is not configured:", error.message);
        response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Discord login is not configured on this server yet.");
        return;
      }

      const state = crypto.randomBytes(32).toString("hex");
      const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
      authorizeUrl.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: config.redirectUri,
        scope: "identify",
        state,
      }).toString();

      redirect(response, authorizeUrl.toString(), [
        cookie(STATE_COOKIE, state, 600, config.secureCookies),
      ]);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/auth/discord/callback") {
      let config;
      try {
        config = getOAuthConfig(environment);
      } catch (error) {
        logger.error("Discord OAuth is not configured:", error.message);
        redirect(response, "/?login=failed", [clearCookie(STATE_COOKIE, false)]);
        return;
      }

      const clearStateCookie = clearCookie(STATE_COOKIE, config.secureCookies);
      if (requestUrl.searchParams.has("error")) {
        redirect(response, "/?login=cancelled", [clearStateCookie]);
        return;
      }

      const state = requestUrl.searchParams.get("state");
      const code = requestUrl.searchParams.get("code");
      if (!safeEqual(state, cookies[STATE_COOKIE]) || !code) {
        redirect(response, "/?login=failed", [clearStateCookie]);
        return;
      }

      try {
        const tokenResponse = await fetchImpl("https://discord.com/api/v10/oauth2/token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: config.redirectUri,
          }),
        });
        if (!tokenResponse.ok) {
          throw new Error(`Discord token exchange failed with status ${tokenResponse.status}.`);
        }

        const tokenPayload = await tokenResponse.json();
        if (typeof tokenPayload.access_token !== "string" || !tokenPayload.access_token) {
          throw new Error("Discord token exchange returned no access token.");
        }

        const userResponse = await fetchImpl("https://discord.com/api/v10/users/@me", {
          headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
        });
        if (!userResponse.ok) {
          throw new Error(`Discord user lookup failed with status ${userResponse.status}.`);
        }

        const discordUser = await userResponse.json();
        if (
          typeof discordUser.id !== "string" ||
          !/^\d+$/.test(discordUser.id) ||
          typeof discordUser.username !== "string"
        ) {
          throw new Error("Discord returned an invalid user profile.");
        }

        const sessionId = crypto.randomBytes(32).toString("hex");
        sessions.set(sessionId, {
          expiresAt: Date.now() + SESSION_LIFETIME_MS,
          user: {
            id: discordUser.id,
            username: discordUser.username,
            displayName:
              typeof discordUser.global_name === "string"
                ? discordUser.global_name
                : discordUser.username,
            avatarUrl:
              typeof discordUser.avatar === "string" &&
              /^[a-zA-Z0-9_]+$/.test(discordUser.avatar)
                ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png?size=64`
                : null,
          },
        });

        redirect(response, "/?login=success", [
          clearStateCookie,
          cookie(SESSION_COOKIE, sessionId, SESSION_MAX_AGE_SECONDS, config.secureCookies),
        ]);
      } catch (error) {
        logger.error("Discord OAuth callback failed:", error);
        redirect(response, "/?login=failed", [clearStateCookie]);
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/me") {
      const now = Date.now();
      for (const [sessionId, session] of sessions) {
        if (session.expiresAt <= now) {
          sessions.delete(sessionId);
        }
      }

      const session = sessions.get(cookies[SESSION_COOKIE]);
      sendJson(response, 200, {
        user: session && session.expiresAt > now ? session.user : null,
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/auth/logout") {
      let config;
      try {
        config = getOAuthConfig(environment);
      } catch (error) {
        logger.error("Discord OAuth is not configured:", error.message);
        sendJson(response, 503, { error: "Discord login is not configured." });
        return;
      }

      if (request.headers.origin !== new URL(config.redirectUri).origin) {
        sendJson(response, 403, { error: "Invalid request origin." });
        return;
      }

      sessions.delete(cookies[SESSION_COOKIE]);
      response.setHeader(
        "Set-Cookie",
        clearCookie(SESSION_COOKIE, config.secureCookies),
      );
      sendJson(response, 200, { ok: true });
      return;
    }

    if (request.method === "GET" && STATIC_FILES.has(requestUrl.pathname)) {
      const [fileName, contentType] = STATIC_FILES.get(requestUrl.pathname);
      try {
        const content = await fs.promises.readFile(path.join(publicDirectory, fileName));
        response.writeHead(200, {
          "Cache-Control": "no-cache",
          "Content-Type": contentType,
        });
        response.end(content);
      } catch (error) {
        logger.error(`Could not read ${fileName}:`, error);
        response.writeHead(500).end("Could not load the website.");
      }
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });
}

if (require.main === module) {
  loadEnvironmentFile();
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  const server = createServer();
  server.listen(port, () => {
    console.log(`NYC Lake Roleplay is available at http://localhost:${port}`);
  });
}

module.exports = { createServer, getOAuthConfig, loadEnvironmentFile };
