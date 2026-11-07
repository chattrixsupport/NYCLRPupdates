const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const SESSION_COOKIE = "nyclrp_session";
const STATE_COOKIE = "nyclrp_oauth_state";
const SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_MAX_AGE_SECONDS = SESSION_LIFETIME_MS / 1000;
const TEAM_MEMBER_COUNT = 2;
const COMMUNITY_INVITE_CODE = "nyclrp";
const COMMUNITY_GUILD_ID = "1475908093266100365";
const COMMUNITY_STATS_CACHE_TTL_MS = 5 * 60 * 1000;
const OAUTH_STATE_LIFETIME_MS = 10 * 60 * 1000;
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/roleplay.html", ["roleplay.html", "text/html; charset=utf-8"]],
  ["/development-team.html", ["development-team.html", "text/html; charset=utf-8"]],
  ["/community.html", ["community.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/script.js", ["script.js", "text/javascript; charset=utf-8"]],
  ["/default-avatar.svg", ["default-avatar.svg", "image/svg+xml"]],
]);
const TEAM_CACHE_TTL_MS = 5 * 60 * 1000;

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

function getServerPort(environment) {
  const port = Number(environment.SERVER_PORT || environment.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SERVER_PORT or PORT must be an integer between 1 and 65535.");
  }
  return port;
}

function getDiscordAvatarUrl(user) {
  if (typeof user.avatar === "string" && /^[a-zA-Z0-9_]+$/.test(user.avatar)) {
    const format = user.avatar.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${format}?size=128`;
  }

  const defaultAvatarIndex =
    !user.discriminator || user.discriminator === "0"
      ? Number((BigInt(user.id) >> 22n) % 6n)
      : Number(user.discriminator) % 5;
  return `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png`;
}

function isDiscordAvatarUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "cdn.discordapp.com" &&
      (url.pathname.startsWith("/avatars/") || url.pathname.startsWith("/embed/avatars/"))
    );
  } catch {
    return false;
  }
}

function createServer({
  environment = process.env,
  fetchImpl = fetch,
  logger = console,
  teamConfigPath = path.join(__dirname, "team.json"),
  teamAvatarsPath = path.join(__dirname, "team-avatars.json"),
} = {}) {
  const sessions = new Map();
  const oauthStates = new Map();
  const teamAvatars = new Map();
  let teamAvatarsLoaded = false;
  let teamAvatarsLoadPromise;
  let teamAvatarWriteQueue = Promise.resolve();
  let communityStatsCache;
  let communityStatsExpiresAt = 0;
  let communityStatsPromise;
  const publicDirectory = __dirname;

  async function loadTeamConfig() {
    const teamConfig = JSON.parse(await fs.promises.readFile(teamConfigPath, "utf8"));
    if (!Array.isArray(teamConfig.members) || teamConfig.members.length !== TEAM_MEMBER_COUNT) {
      throw new Error(`team.json must contain exactly ${TEAM_MEMBER_COUNT} team members.`);
    }

    const ids = new Set();
    for (const member of teamConfig.members) {
      if (
        !member ||
        typeof member.id !== "string" ||
        !/^\d+$/.test(member.id) ||
        ids.has(member.id) ||
        typeof member.name !== "string" ||
        !member.name.trim() ||
        typeof member.role !== "string" ||
        !member.role.trim() ||
        typeof member.avatar !== "string" ||
        !member.avatar.trim()
      ) {
        throw new Error("Each team member needs a unique Discord ID, name, role, and fallback avatar in team.json.");
      }
      ids.add(member.id);
    }

    return teamConfig.members;
  }

  async function loadTeamAvatars() {
    if (teamAvatarsLoaded) {
      return;
    }
    if (!teamAvatarsLoadPromise) {
      teamAvatarsLoadPromise = fs.promises
        .readFile(teamAvatarsPath, "utf8")
        .then((contents) => {
          const savedAvatars = JSON.parse(contents);
          if (!savedAvatars || typeof savedAvatars !== "object" || Array.isArray(savedAvatars)) {
            throw new Error("Saved team avatars are invalid.");
          }
          for (const [userId, avatarUrl] of Object.entries(savedAvatars)) {
            if (/^\d+$/.test(userId) && isDiscordAvatarUrl(avatarUrl)) {
              teamAvatars.set(userId, avatarUrl);
            }
          }
        })
        .catch((error) => {
          if (error.code !== "ENOENT") {
            throw error;
          }
        })
        .then(() => {
          teamAvatarsLoaded = true;
        })
        .catch((error) => {
          teamAvatarsLoadPromise = undefined;
          throw error;
        });
    }
    await teamAvatarsLoadPromise;
  }

  function saveTeamAvatar(userId, avatarUrl) {
    teamAvatarWriteQueue = teamAvatarWriteQueue
      .catch(() => {})
      .then(async () => {
        await loadTeamAvatars();
        teamAvatars.set(userId, avatarUrl);
        const temporaryPath = `${teamAvatarsPath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
        try {
          await fs.promises.writeFile(
            temporaryPath,
            JSON.stringify(Object.fromEntries(teamAvatars), null, 2),
            { mode: 0o600 },
          );
          await fs.promises.rename(temporaryPath, teamAvatarsPath);
        } finally {
          await fs.promises.rm(temporaryPath, { force: true });
        }
      });
    return teamAvatarWriteQueue;
  }

  async function loadCommunityStats() {
    if (communityStatsCache && communityStatsExpiresAt > Date.now()) {
      return communityStatsCache;
    }
    if (communityStatsPromise) {
      return communityStatsPromise;
    }

    communityStatsPromise = (async () => {
      const response = await fetchImpl(
        `https://discord.com/api/v10/invites/${COMMUNITY_INVITE_CODE}?with_counts=true`,
      );
      if (!response.ok) {
        throw new Error(`Discord community stats request failed with status ${response.status}.`);
      }

      const invite = await response.json();
      if (
        !invite ||
        invite.guild?.id !== COMMUNITY_GUILD_ID ||
        typeof invite.guild.name !== "string" ||
        !Number.isSafeInteger(invite.approximate_member_count) ||
        invite.approximate_member_count < 0 ||
        !Number.isSafeInteger(invite.approximate_presence_count) ||
        invite.approximate_presence_count < 0
      ) {
        throw new Error("Discord returned invalid community statistics.");
      }

      communityStatsCache = {
        name: invite.guild.name,
        memberCount: invite.approximate_member_count,
        onlineCount: invite.approximate_presence_count,
      };
      communityStatsExpiresAt = Date.now() + COMMUNITY_STATS_CACHE_TTL_MS;
      return communityStatsCache;
    })().finally(() => {
      communityStatsPromise = undefined;
    });

    return communityStatsPromise;
  }

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

    if (request.method === "GET" && requestUrl.pathname === "/api/community") {
      try {
        sendJson(response, 200, await loadCommunityStats());
      } catch (error) {
        logger.error("Could not load Discord community statistics:", error);
        sendJson(response, 502, { error: "Could not load Discord community statistics." });
      }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/team") {
      try {
        const configuredMembers = await loadTeamConfig();
        await loadTeamAvatars();
        const members = configuredMembers.map((member) => ({
          name: member.name.trim(),
          role: member.role.trim(),
          avatar: teamAvatars.get(member.id) || member.avatar,
        }));
        sendJson(response, 200, { members });
      } catch (error) {
        logger.error("Could not load development team:", error);
        sendJson(response, 500, { error: "Could not load the development team." });
      }
      return;
    }

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
      const now = Date.now();
      for (const [savedState, savedRequest] of oauthStates) {
        if (savedRequest.expiresAt <= now) {
          oauthStates.delete(savedState);
        }
      }
      const returnTo =
        requestUrl.searchParams.get("returnTo") === "/community.html"
          ? "/community.html"
          : "/";
      oauthStates.set(state, {
        returnTo,
        expiresAt: now + OAUTH_STATE_LIFETIME_MS,
      });
      const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
      authorizeUrl.search = new URLSearchParams({
        client_id: config.clientId,
        response_type: "code",
        redirect_uri: config.redirectUri,
        scope: "identify guilds.members.read",
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
      const state = requestUrl.searchParams.get("state");
      const pendingState = oauthStates.get(state);
      if (pendingState) {
        oauthStates.delete(state);
      }
      const returnTo =
        pendingState && pendingState.expiresAt > Date.now() ? pendingState.returnTo : "/";
      if (requestUrl.searchParams.has("error")) {
        redirect(response, `${returnTo}?login=cancelled`, [clearStateCookie]);
        return;
      }

      const code = requestUrl.searchParams.get("code");
      if (
        !safeEqual(state, cookies[STATE_COOKIE]) ||
        !pendingState ||
        pendingState.expiresAt <= Date.now() ||
        !code
      ) {
        redirect(response, `${returnTo}?login=failed`, [clearStateCookie]);
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

        const membershipUrl =
          `https://discord.com/api/v10/users/@me/guilds/${COMMUNITY_GUILD_ID}/member`;
        const membershipResponse = await fetchImpl(membershipUrl, {
          headers: { Authorization: ["Bearer", tokenPayload.access_token].join(" ") },
        });
        if (!membershipResponse.ok && membershipResponse.status !== 403) {
          throw new Error(
            `Discord community membership lookup failed with status ${membershipResponse.status}.`,
          );
        }
        if (membershipResponse.ok) {
          const membership = await membershipResponse.json();
          if (!membership || typeof membership !== "object" || Array.isArray(membership)) {
            throw new Error("Discord returned invalid community membership data.");
          }
        }
        const isCommunityMember = membershipResponse.ok;

        const avatarUrl = getDiscordAvatarUrl(discordUser);
        try {
          const teamMembers = await loadTeamConfig();
          if (teamMembers.some((member) => member.id === discordUser.id)) {
            await saveTeamAvatar(discordUser.id, avatarUrl);
          }
        } catch (error) {
          logger.error("Could not update the development team avatar:", error);
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
            avatarUrl,
            isCommunityMember,
          },
        });

        redirect(response, `${returnTo}?login=success`, [
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
  const port = getServerPort(process.env);
  const server = createServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`NYC Lake Roleplay is listening on 0.0.0.0:${port}`);
  });
}

module.exports = { createServer, getOAuthConfig, getServerPort, loadEnvironmentFile };
